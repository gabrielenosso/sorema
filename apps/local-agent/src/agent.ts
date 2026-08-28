import { resolve } from 'node:path';
import { platform } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { SoremaError, type Capability, type SoremaEvent } from '@sorema/domain-model';
import { InMemoryEventBus, type EventBus } from '@sorema/event-bus';
import { createLogger, type Logger } from '@sorema/observability';
import type { DeviceCommand } from '@sorema/protocol';
import { resolveFromWorkspaceRoot, type LocalAgentConfig } from '@sorema/config';
import { createLocalAgentDatabase, type LocalAgentDatabase } from './db/client.js';
import { LocalStore } from './store/local-store.js';
import { DeviceIdentityStore } from './identity/device-identity-store.js';
import { ProjectRegistry } from './projects/project-registry.js';
import { CodingDomainAdapter } from './domains/coding/coding-domain-adapter.js';
import { MachineMemory } from './memory/machine-memory.js';
import { MemoryDomainAdapter } from './memory/memory-domain-adapter.js';
import { CodexCliProvider } from './domains/coding/providers/codex-cli-provider.js';
import { FakeCodingProvider } from './domains/coding/providers/fake-coding-provider.js';
import { ClaudeCodeProvider } from './domains/coding/providers/claude-code-provider.js';
import type { CodingProvider } from './domains/coding/provider-types.js';
import type { DomainAdapter } from './domains/domain-adapter.js';
import { localAgentVersion, detectCapabilities } from './capabilities/capability-detector.js';
import {
  CloudTunnelClient,
  type CloudJobUpdate as TunnelCloudJobUpdate,
} from './tunnel/cloud-tunnel-client.js';
import { openCloudSocket } from './tunnel/cloud-socket.js';
import { CommandRateLimiter } from './process/command-rate-limiter.js';

export type LocalAgent = {
  config: LocalAgentConfig;
  database: LocalAgentDatabase;
  store: LocalStore;
  identity: DeviceIdentityStore;
  projectRegistry: ProjectRegistry;
  codingAdapter: CodingDomainAdapter;
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

/**
 * Which job events travel to the cloud unprompted, and what the cloud should call them.
 *
 * The end of a job has always travelled: whoever started it may have closed the tab, so the news has
 * to be written down where it can wait. Both summaries travel: `summary` is what the agent wrote and
 * is what the screen shows, `spokenSummary` is the sentence written to be read aloud. Sending only
 * the second is how a whole review reached the user as its first paragraph.
 *
 * The beginning travels for a different reason. `get_job_status` is answered from the row the cloud
 * keeps, and until the machine has said something there is no row — so asking about a task that was
 * running answered "no job with that id", which the assistant reads out as the task not existing.
 * Two writes per job buy a truthful answer for the whole of its life.
 *
 * Progress deliberately does not travel. It arrives once per line the coding agent prints, and each
 * one would be a write to a table whose capacity every tenant shares, to move a number nobody says
 * out loud. What a job is doing right now is a question for the machine, which is awake if it is
 * running the job.
 *
 * A job that ends badly travels with the reason it ended badly. Both endings used to arrive as
 * `failed` with an empty summary, so the cloud stored nothing, `get_job_status` answered "The task
 * is failed." with nothing after it, and the notification said the same — while the adapter had
 * published the whole structured error one function call earlier. Cancelling was worse than empty:
 * `cancel_job` answered "cancelled" and asking about the same job a second later answered "failed",
 * so the two halves of one conversation contradicted each other.
 *
 * The narrowing below is on `event.type` rather than a cast, so renaming a field on either event
 * stops this compiling instead of quietly sending an empty string again.
 */
export type CloudJobUpdate = Omit<TunnelCloudJobUpdate, 'deviceId'> & {
  eventType:
    | 'job.queued'
    | 'job.started'
    | 'job.completed'
    | 'job.failed'
    | 'job.cancelled'
    | 'approval.required';
};

export function jobUpdateForCloud(event: SoremaEvent): CloudJobUpdate | null {
  const envelope = { eventId: event.eventId, occurredAt: event.occurredAt };
  if (event.type === 'job.queued') {
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'queued',
      summary: '',
    };
  }
  if (event.type === 'job.started') {
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'running',
      summary: '',
    };
  }
  if (event.type === 'job.completed') {
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'succeeded',
      // Both, and this used to be one. Sending only the spoken sentence meant the long summary never
      // left the machine: the screen and the voice were given one field and it was the short one, so
      // a whole review arrived as its first paragraph and the user asked why.
      summary: event.payload.summary || event.payload.spokenSummary,
      spokenSummary: event.payload.spokenSummary || event.payload.summary,
    };
  }
  if (event.type === 'job.failed') {
    // `userMessage` first because it is the half of a structured error written to be said out loud;
    // `message` is the technical half and is only reached when a producer left the other one empty.
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'failed',
      summary: event.payload.error.userMessage || event.payload.error.message,
    };
  }
  if (event.type === 'job.cancelled') {
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'cancelled',
      summary: event.payload.reason,
    };
  }
  if (event.type === 'approval.required') {
    return {
      ...envelope,
      eventType: event.type,
      jobId: event.payload.jobId,
      domainSessionId: event.payload.domainSessionId,
      status: 'waiting_for_approval',
      summary: event.payload.spokenSummary,
    };
  }
  return null;
}

export function buildLocalAgent(config: LocalAgentConfig): LocalAgent {
  const logger = createLogger(
    'local-agent',
    config.logLevel,
    config.nodeEnvironment !== 'production',
  );
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

  const reportJobToCloud = (event: SoremaEvent): void => {
    if (!cloudTunnel) return;
    const update = jobUpdateForCloud(event);
    if (update) {
      const durableUpdate = { ...update, deviceId: identity.deviceId ?? 'unpaired' };
      store.saveCloudEvent(update.eventId, durableUpdate);
      cloudTunnel.reportJob(durableUpdate);
    }
  };

  const publishEvent = (event: SoremaEvent): void => {
    void eventBus.publish(event);
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

  // Registered unconditionally. Which memory the product uses is decided in the cloud, and a daemon
  // that only grew the ability to answer after an upgrade would leave every older machine unable to
  // remember anything the moment the mode changed.
  const memoryAdapter = new MemoryDomainAdapter(
    new MachineMemory(resolveFromWorkspaceRoot(config.stateDirectory)),
  );

  const adapters: DomainAdapter[] = [codingAdapter, memoryAdapter];

  const getCapabilities = (): Promise<Capability[]> =>
    detectCapabilities({ projectRegistry, adapters, demoMode: config.demoMode });

  const rateLimiter = new CommandRateLimiter();

  /**
   * One command, run once, whatever asked for it.
   *
   * The rate limiter, the domain routing and the refusal messages live here rather than in the
   * transport, so a second caller cannot end up with its own slightly different dispatch.
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

  /** The transport, present only when a deployment has been named. */
  const cloudTunnel = config.cloudTunnelUrl
    ? new CloudTunnelClient({
        tunnelUrl: config.cloudTunnelUrl,
        identity,
        agentVersion: localAgentVersion(),
        platform: platform(),
        codingAgents: async () =>
          (await codingAdapter.listAvailableProviders()).map((provider) => provider.providerId),
        createSocket: openCloudSocket,
        log: (message, detail) => logger.info(detail ?? {}, message),
        reconnectInitialDelayMs: config.reconnectInitialDelayMs,
        reconnectMaxDelayMs: config.reconnectMaxDelayMs,
        loadPendingJobUpdates: () => store.listCloudEvents().filter(isCloudJobUpdate),
        acknowledgeJobUpdate: (eventId) => store.deleteCloudEvent(eventId),
        handleCommand: (command, requestId) =>
          runCommand(command as DeviceCommand, {
            userId: identity.userId ?? 'unpaired',
            deviceId: identity.deviceId ?? 'unpaired',
            correlationId: requestId,
            idempotencyKey: requestId,
          }),
      })
    : null;

  const loopbackServer = Fastify({ logger: false });

  loopbackServer.get('/health', async () => ({
    status: 'ok',
    version: localAgentVersion(),
    paired: identity.isPaired,
    tunnel: { connected: cloudTunnel?.isConnected ?? false },
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
    eventBus,
    logger,
    loopbackServer,
    getCapabilities,
    start: async () => {
      // The port is claimed before anything is written, which is what makes this daemon the single
      // writer by construction rather than by everybody remembering. It used to be the other way
      // round: marking interrupted jobs came first, so a manual `sorema start` beside the installed
      // service marked the *service's* live jobs as interrupted, told the cloud they had failed, and
      // only then discovered the address was taken and exited. The second instance did nothing but
      // damage, and the machine that was working reported the work it was doing as dead.
      await loopbackServer.listen({ host: config.loopbackHost, port: config.loopbackPort });
      logger.info(
        { host: config.loopbackHost, port: config.loopbackPort },
        'local agent loopback api listening',
      );

      const interrupted = codingAdapter.markInterruptedJobsAfterRestart();
      if (interrupted.length > 0) {
        logger.warn(
          { interruptedJobCount: interrupted.length },
          'marked jobs as interrupted after restart',
        );
      }
      cloudTunnel?.start();
    },
    close: async () => {
      await codingAdapter.shutdown();
      cloudTunnel?.stop();
      await loopbackServer.close();
      database.close();
    },
  };
}

function isCloudJobUpdate(payload: Record<string, unknown>): payload is TunnelCloudJobUpdate {
  return (
    typeof payload.eventId === 'string' &&
    typeof payload.eventType === 'string' &&
    typeof payload.occurredAt === 'string' &&
    typeof payload.jobId === 'string' &&
    typeof payload.deviceId === 'string' &&
    typeof payload.status === 'string'
  );
}
