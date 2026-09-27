import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { localAgentConfigSchema } from '@sorema/config';
import { nowIsoTimestamp } from '@sorema/domain-model';
import { buildLocalAgent, type LocalAgent } from '../src/agent.js';
import { DeviceIdentityStore } from '../src/identity/device-identity-store.js';
import type { AgentRelease } from '../src/release/agent-release.js';

type CommandReply = { result?: Record<string, unknown>; error?: Record<string, unknown> };

type FakeCloud = {
  url: string;
  connected: Promise<WebSocket>;
  jobUpdates: string[];
  sendCommand: (name: string, payload: Record<string, unknown>) => Promise<CommandReply>;
  acknowledgeJobUpdate: (eventId: string) => void;
  close: () => Promise<void>;
};

const openAgents: LocalAgent[] = [];
const openClouds: FakeCloud[] = [];
const originalAgentVersion = process.env.SOREMA_AGENT_VERSION;

beforeEach(() => {
  process.env.SOREMA_AGENT_VERSION = '0.9.20';
});

afterEach(async () => {
  while (openAgents.length > 0) await openAgents.pop()?.close();
  while (openClouds.length > 0) await openClouds.pop()?.close();
  if (originalAgentVersion === undefined) delete process.env.SOREMA_AGENT_VERSION;
  else process.env.SOREMA_AGENT_VERSION = originalAgentVersion;
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!address || typeof address === 'string') throw new Error('No local test port was assigned');
  return address.port;
}

async function startFakeCloud(options: {
  holdJobUpdateAcknowledgements: boolean;
}): Promise<FakeCloud> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolvePromise) => server.once('listening', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fake cloud has no port');
  const pendingReplies = new Map<string, (reply: CommandReply) => void>();
  const jobUpdates: string[] = [];
  let activeSocket: WebSocket | null = null;
  let requestCounter = 0;

  const connected = new Promise<WebSocket>((resolvePromise) => {
    server.on('connection', (socket) => {
      activeSocket = socket;
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          type: string;
          payload: Record<string, unknown>;
        };
        if (message.type === 'job_update') {
          const eventId = String(message.payload.eventId);
          jobUpdates.push(eventId);
          if (!options.holdJobUpdateAcknowledgements) {
            socket.send(JSON.stringify({ type: 'job_update_ack', payload: { eventId } }));
          }
        }
        if (message.type === 'command_result') {
          const requestId = String(message.payload.requestId);
          pendingReplies.get(requestId)?.({
            result: message.payload.result as Record<string, unknown> | undefined,
            error: message.payload.error as Record<string, unknown> | undefined,
          });
          pendingReplies.delete(requestId);
        }
      });
      resolvePromise(socket);
    });
  });

  const cloud: FakeCloud = {
    url: `ws://127.0.0.1:${address.port}`,
    connected,
    jobUpdates,
    sendCommand: async (name, payload) => {
      const socket = await connected;
      requestCounter += 1;
      const requestId = `request-${requestCounter}`;
      const reply = new Promise<CommandReply>((resolvePromise) =>
        pendingReplies.set(requestId, resolvePromise),
      );
      socket.send(
        JSON.stringify({
          type: 'command_request',
          payload: { requestId, command: { name, payload } },
        }),
      );
      return reply;
    },
    acknowledgeJobUpdate: (eventId) =>
      activeSocket?.send(JSON.stringify({ type: 'job_update_ack', payload: { eventId } })),
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
  openClouds.push(cloud);
  return cloud;
}

type RecordingRelease = AgentRelease & {
  preparedVersions: string[];
  finishPreparing: () => void;
  failPreparing: (error: Error) => void;
};

function recordingRelease(latestVersion: string): RecordingRelease {
  const preparedVersions: string[] = [];
  let finishPreparing: () => void = () => {};
  let failPreparing: (error: Error) => void = () => {};
  return {
    preparedVersions,
    fetchLatestVersion: async () => latestVersion,
    prepareReplacement: (version) => {
      preparedVersions.push(version);
      return new Promise<void>((resolvePromise, reject) => {
        finishPreparing = resolvePromise;
        failPreparing = reject;
      });
    },
    get finishPreparing() {
      return finishPreparing;
    },
    get failPreparing() {
      return failPreparing;
    },
  };
}

async function startPairedAgent(
  cloud: FakeCloud,
  release: AgentRelease | undefined,
  onExitForReplacement: () => void,
  seedOutbox: (agent: LocalAgent) => void = () => {},
): Promise<LocalAgent> {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'sorema-agent-update-'));
  new DeviceIdentityStore(stateDirectory).recordPairing('device-under-test', 'user-under-test');
  const agent = buildLocalAgent(
    localAgentConfigSchema.parse({
      cloudTunnelUrl: cloud.url,
      loopbackPort: await availablePort(),
      stateDirectory,
      databaseUrl: `file:${join(stateDirectory, 'sorema.sqlite')}`,
      logLevel: 'fatal',
    }),
    {
      release,
      exitForReplacement: async () => onExitForReplacement(),
    },
  );
  openAgents.push(agent);
  seedOutbox(agent);
  await agent.start();
  await cloud.connected;
  return agent;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await pause(25);
  }
  return condition();
}

describe('updating the agent from the web app, over the real tunnel', () => {
  it('installs the version the release source names, ignoring anything the command carries', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    const release = recordingRelease('0.9.21');
    let exitedForReplacement = false;
    await startPairedAgent(cloud, release, () => {
      exitedForReplacement = true;
    });

    const reply = await cloud.sendCommand('agent.update', {
      version: '6.6.6',
      packageSpecifier: 'https://attacker.example/sorema.tgz',
    });

    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ currentVersion: '0.9.20', targetVersion: '0.9.21' });
    expect(await eventually(() => release.preparedVersions.length === 1)).toBe(true);
    expect(release.preparedVersions).toEqual(['0.9.21']);
    expect(exitedForReplacement).toBe(false);

    release.finishPreparing();
    expect(await eventually(() => exitedForReplacement)).toBe(true);
  });

  it('refuses every other command while the replacement is being prepared', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    const release = recordingRelease('0.9.21');
    await startPairedAgent(cloud, release, () => {});

    await cloud.sendCommand('agent.update', {});
    const refused = await cloud.sendCommand('jobs.list', {});

    expect(refused.result).toBeUndefined();
    expect(String(refused.error?.userMessage)).toMatch(/updating/i);
  });

  it('refuses while a task is running, says why, and prepares nothing', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    const release = recordingRelease('0.9.21');
    const agent = await startPairedAgent(cloud, release, () => {});
    const timestamp = nowIsoTimestamp();
    agent.store.saveJob({
      id: 'job-in-flight',
      userId: 'user-under-test',
      deviceId: 'device-under-test',
      domain: 'coding',
      type: 'coding.task',
      status: 'running',
      createdAt: timestamp,
      startedAt: timestamp,
      idempotencyKey: 'idempotency-in-flight',
      correlationId: 'correlation-in-flight',
      instruction: 'work that is happening right now',
      providerId: 'fake',
    });

    const reply = await cloud.sendCommand('agent.update', {});

    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBe('COMMAND_REJECTED');
    expect(String(reply.error?.userMessage)).toMatch(/task is running/i);
    expect(release.preparedVersions).toEqual([]);
  });

  it('refuses when the machine already runs the latest version, comparing numerically', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    const release = recordingRelease('0.9.3');
    await startPairedAgent(cloud, release, () => {});

    const reply = await cloud.sendCommand('agent.update', {});

    expect(reply.error?.code).toBe('COMMAND_REJECTED');
    expect(String(reply.error?.userMessage)).toMatch(/latest version/i);
    expect(release.preparedVersions).toEqual([]);
  });

  it('refuses on a build that was not installed from a release', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    await startPairedAgent(cloud, undefined, () => {});

    const reply = await cloud.sendCommand('agent.update', {});

    expect(reply.error?.code).toBe('COMMAND_REJECTED');
    expect(String(reply.error?.userMessage)).toMatch(/cannot update itself/i);
  });

  it('stays running and answers again when the replacement could not be started', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: false });
    const release = recordingRelease('0.9.21');
    let exitedForReplacement = false;
    await startPairedAgent(cloud, release, () => {
      exitedForReplacement = true;
    });

    await cloud.sendCommand('agent.update', {});
    expect(await eventually(() => release.preparedVersions.length === 1)).toBe(true);
    release.failPreparing(new Error('the replacement never started'));

    await pause(300);
    expect((await cloud.sendCommand('jobs.list', {})).result).toEqual({ jobs: [] });
    expect(exitedForReplacement).toBe(false);
  });

  it('does not exit until the cloud has acknowledged every job update still in the outbox', async () => {
    const cloud = await startFakeCloud({ holdJobUpdateAcknowledgements: true });
    const release = recordingRelease('0.9.21');
    let exitedForReplacement = false;
    await startPairedAgent(
      cloud,
      release,
      () => {
        exitedForReplacement = true;
      },
      (agent) =>
        agent.store.saveCloudEvent('event-not-yet-delivered', {
          eventId: 'event-not-yet-delivered',
          eventType: 'job.completed',
          occurredAt: nowIsoTimestamp(),
          jobId: 'job-finished-earlier',
          deviceId: 'device-under-test',
          status: 'succeeded',
          summary: 'done',
        }),
    );
    expect(await eventually(() => cloud.jobUpdates.includes('event-not-yet-delivered'))).toBe(true);

    await cloud.sendCommand('agent.update', {});
    expect(await eventually(() => release.preparedVersions.length === 1)).toBe(true);
    release.finishPreparing();
    await pause(1_000);
    expect(exitedForReplacement).toBe(false);

    cloud.acknowledgeJobUpdate('event-not-yet-delivered');
    expect(await eventually(() => exitedForReplacement)).toBe(true);
  });
});
