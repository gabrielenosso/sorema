import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SoremaError, type Capability, type SoremaEvent } from '@sorema/domain-model';
import { InMemoryEventBus, type EventBus } from '@sorema/event-bus';
import { MetricsRegistry, createLogger, type Logger } from '@sorema/observability';
import type { CommandRequestMessage, DeviceCommand } from '@sorema/protocol';
import { resolveFromWorkspaceRoot, type LocalAgentConfig } from '@sorema/config';
import { createLocalAgentDatabase, type LocalAgentDatabase } from './db/client.js';
import { LocalStore } from './store/local-store.js';
import { DeviceIdentityStore } from './identity/device-identity-store.js';
import { ProjectRegistry } from './projects/project-registry.js';
import { CodingDomainAdapter } from './domains/coding/coding-domain-adapter.js';
import { CodexCliProvider } from './domains/coding/providers/codex-cli-provider.js';
import { FakeCodingProvider } from './domains/coding/providers/fake-coding-provider.js';
import { ClaudeCodeProvider } from './domains/coding/providers/claude-code-provider.js';
import type { CodingProvider } from './domains/coding/provider-types.js';
import type { DomainAdapter } from './domains/domain-adapter.js';
import { LOCAL_AGENT_VERSION, detectCapabilities } from './capabilities/capability-detector.js';
import { TunnelClient } from './tunnel/tunnel-client.js';
import { CloudTunnelClient } from './tunnel/cloud-tunnel-client.js';
import { openCloudSocket } from './tunnel/cloud-socket.js';
import { CommandRateLimiter } from './process/command-rate-limiter.js';

export type LocalAgent = {
  config: LocalAgentConfig;
  database: LocalAgentDatabase;
  store: LocalStore;
  identity: DeviceIdentityStore;
  projectRegistry: ProjectRegistry;
  codingAdapter: CodingDomainAdapter;
  tunnelClient: TunnelClient;
  eventBus: EventBus;
  logger: Logger;
  loopbackServer: FastifyInstance;
  getCapabilities: () => Promise<Capability[]>;
  start: () => Promise<void>;
  close: () => Promise<void>;
};

export function buildCodingProviders(config: LocalAgentConfig, logger: Logger): CodingProvider[] {
  const providers: CodingProvider[] = [];
  if (config.demoMode) providers.push(new FakeCodingProvider());
  providers.push(
    new CodexCliProvider({
      executablePath: config.codexExecutablePath,
      sandboxMode: config.codexSandboxMode,
      stateDirectory: resolve(resolveFromWorkspaceRoot(config.stateDirectory), 'codex'),
      jobTimeoutMs: config.jobTimeoutMs,
      maxOutputBytes: config.maxJobOutputBytes,
      logger,
    }),
  );
  providers.push(
    new ClaudeCodeProvider({
      executablePath: config.claudeCodeExecutablePath,
      stateDirectory: resolve(resolveFromWorkspaceRoot(config.stateDirectory), 'claude'),
      jobTimeoutMs: config.jobTimeoutMs,
      maxOutputBytes: config.maxJobOutputBytes,
      logger,
    }),
  );
  return providers;
}

export function buildLocalAgent(config: LocalAgentConfig): LocalAgent {
  const logger = createLogger(
    'local-agent',
    config.logLevel,
    config.nodeEnvironment !== 'production',
  );
  const metrics = new MetricsRegistry();
  const database = createLocalAgentDatabase(config.databaseUrl);
  const store = new LocalStore(database);
  const identity = new DeviceIdentityStore(resolveFromWorkspaceRoot(config.stateDirectory));
  const projectRegistry = new ProjectRegistry(config.allowedWorkspaceRoots);
  const eventBus: EventBus = new InMemoryEventBus((error, event) => {
    logger.error(
      { eventId: event.eventId, error: error instanceof Error ? error.message : String(error) },
      'local event handler threw',
    );
  });

  /**
   * The end of a job is the only thing the cloud needs pushed to it unprompted.
   *
   * Everything else it asks for and waits on. A finished job is different: whoever started it may
   * have closed the tab, so the news has to travel on its own and be written down where it can wait.
   * `spokenSummary` is preferred because it is the sentence written to be read aloud.
   */
  const reportJobToCloud = (event: SoremaEvent): void => {
    if (!cloudTunnel) return;
    const payload = event.payload as { jobId?: string; spokenSummary?: string; summary?: string };
    if (!payload.jobId) return;

    if (event.type === 'job.completed') {
      cloudTunnel.reportJob({
        jobId: payload.jobId,
        status: 'succeeded',
        summary: payload.spokenSummary ?? payload.summary ?? '',
      });
    }
    if (event.type === 'job.failed' || event.type === 'job.cancelled') {
      cloudTunnel.reportJob({ jobId: payload.jobId, status: 'failed', summary: '' });
    }
  };

  const publishEvent = (event: SoremaEvent): void => {
    void eventBus.publish(event);
    tunnelClient.publishEvent(event);
    reportJobToCloud(event);
  };

  const codingAdapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers: buildCodingProviders(config, logger),
    publishEvent,
    logger,
    userId: identity.userId ?? 'unpaired',
    deviceId: identity.deviceId ?? 'unpaired',
    demoMode: config.demoMode,
  });

  const adapters: DomainAdapter[] = [codingAdapter];

  const getCapabilities = (): Promise<Capability[]> =>
    detectCapabilities({ projectRegistry, adapters, demoMode: config.demoMode });

  const rateLimiter = new CommandRateLimiter();

  /**
   * One command, run once, whichever transport carried it.
   *
   * Extracted because there are now two: the gateway on this machine, and the cloud tunnel. Letting
   * each build its own dispatch would mean the rate limiter, the domain routing and the refusal
   * messages drifting apart, and the difference showing up only on whichever one is used less.
   */
  const runCommand = async (
    command: DeviceCommand,
    context: { userId: string; deviceId: string; correlationId: string; idempotencyKey: string },
  ): Promise<unknown> => {
    const commandName = command.name;
    rateLimiter.check(commandName, store.listJobs({ activeOnly: true }).length);
    if (commandName === 'capabilities.list') {
      return { capabilities: await getCapabilities() };
    }
    const requestedDomain =
      'domain' in command.payload ? (command.payload.domain as string | undefined) : undefined;
    const adapter = adapters.find((candidate) => candidate.handles(commandName, requestedDomain));
    if (!adapter) {
      throw SoremaError.of(
        'COMMAND_REJECTED',
        requestedDomain
          ? `This computer has nothing that can do ${requestedDomain} work`
          : `No adapter handles ${commandName}`,
        {
          userMessage: requestedDomain
            ? `Your computer cannot do that kind of work yet.`
            : `I cannot do that on your computer.`,
        },
      );
    }
    return adapter.execute({
      command,
      userId: context.userId,
      deviceId: context.deviceId,
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
    });
  };

  const handleCommand = async (message: CommandRequestMessage): Promise<unknown> =>
    runCommand(message.payload.command, {
      userId: message.userId ?? identity.userId ?? 'unpaired',
      deviceId: identity.deviceId ?? 'unpaired',
      correlationId: message.correlationId,
      idempotencyKey: message.payload.idempotencyKey,
    });

  const tunnelClient = new TunnelClient({
    gatewayTunnelUrl: config.gatewayTunnelUrl,
    identity,
    store,
    logger,
    metrics,
    deviceName: config.deviceName,
    agentVersion: LOCAL_AGENT_VERSION,
    platform: platform(),
    getCapabilities,
    handleCommand,
    reconnectInitialDelayMs: config.reconnectInitialDelayMs,
    reconnectMaxDelayMs: config.reconnectMaxDelayMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    outboxFlushIntervalMs: config.outboxFlushIntervalMs,
  });

  /**
   * The cloud transport, present only when a deployment has been named.
   *
   * Both can exist at once without conflicting: they carry the same commands to the same executor,
   * and a machine that has been paired with a deployment but still has a gateway running locally is
   * a perfectly ordinary state during a migration.
   */
  const cloudTunnel = config.cloudTunnelUrl
    ? new CloudTunnelClient({
        tunnelUrl: config.cloudTunnelUrl,
        identity,
        createSocket: openCloudSocket,
        log: (message, detail) => logger.info(detail ?? {}, message),
        reconnectInitialDelayMs: config.reconnectInitialDelayMs,
        reconnectMaxDelayMs: config.reconnectMaxDelayMs,
        handleCommand: (command) =>
          runCommand(command as DeviceCommand, {
            userId: identity.userId ?? 'unpaired',
            deviceId: identity.deviceId ?? 'unpaired',
            correlationId: randomUUID(),
            // The cloud gives each tool call its own request id and waits on it, so a retry of the
            // same call is a different request; there is nothing here to deduplicate against.
            idempotencyKey: randomUUID(),
          }),
      })
    : null;

  const loopbackServer = Fastify({ logger: false });

  loopbackServer.get('/health', async () => ({
    status: 'ok',
    version: LOCAL_AGENT_VERSION,
    paired: identity.isPaired,
    tunnel: tunnelClient.describeStatus(),
    demoMode: config.demoMode,
  }));

  loopbackServer.get('/capabilities', async () => ({ capabilities: await getCapabilities() }));

  loopbackServer.get('/jobs', async (request) => {
    const activeOnly = (request.query as { active?: string }).active === 'true';
    return { jobs: store.listJobs({ activeOnly }) };
  });

  loopbackServer.get('/sessions', async () => ({ sessions: store.listDomainSessions() }));

  return {
    config,
    database,
    store,
    identity,
    projectRegistry,
    codingAdapter,
    tunnelClient,
    eventBus,
    logger,
    loopbackServer,
    getCapabilities,
    start: async () => {
      const interrupted = codingAdapter.markInterruptedJobsAfterRestart();
      if (interrupted.length > 0) {
        logger.warn(
          { interruptedJobCount: interrupted.length },
          'marked jobs as interrupted after restart',
        );
      }
      await loopbackServer.listen({ host: config.loopbackHost, port: config.loopbackPort });
      logger.info(
        { host: config.loopbackHost, port: config.loopbackPort },
        'local agent loopback api listening',
      );
      tunnelClient.start();
      cloudTunnel?.start();
    },
    close: async () => {
      await codingAdapter.shutdown();
      cloudTunnel?.stop();
      await tunnelClient.stop();
      await loopbackServer.close();
      database.$client.close();
    },
  };
}
