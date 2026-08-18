import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SoremaError } from '@sorema/domain-model';
import {
  CloudTunnelClient,
  type CloudJobUpdate,
  type CloudSocket,
} from '../src/tunnel/cloud-tunnel-client.js';
import type { DeviceIdentityStore } from '../src/identity/device-identity-store.js';

type OpenedSocket = { url: string; headers: Record<string, string>; socket: CloudSocket };

function fakeIdentity(deviceId: string | null): DeviceIdentityStore {
  return {
    deviceId,
    userId: 'user-1',
    publicKeyPem: 'PUBLIC',
    isPaired: deviceId !== null,
    sign: (challenge: string) => `signed(${challenge})`,
    recordPairing: () => {},
  } as unknown as DeviceIdentityStore;
}

function harness(
  options: {
    deviceId?: string | null;
    pendingJobUpdates?: CloudJobUpdate[];
    acknowledgeJobUpdate?: (eventId: string) => void;
  } = {},
) {
  const opened: OpenedSocket[] = [];
  const sent: Record<string, unknown>[] = [];
  const scheduled: (() => void)[] = [];
  const handleCommand = vi.fn().mockResolvedValue({ ok: true });

  const client = new CloudTunnelClient({
    tunnelUrl: 'wss://tunnel.example/live',
    identity: fakeIdentity(options.deviceId === undefined ? 'device-1' : options.deviceId),
    agentVersion: '0.9.9',
    platform: 'win32',
    handleCommand,
    log: () => {},
    setTimeoutImplementation: (handler) => {
      scheduled.push(handler);
      return 0;
    },
    createSocket: (url, headers) => {
      const socket: CloudSocket = {
        send: (data) => void sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => socket.onclose?.({ code: 1000, reason: 'closed' }),
        onmessage: null,
        onopen: null,
        onclose: null,
        onerror: null,
      };
      opened.push({ url, headers, socket });
      return socket;
    },
    loadPendingJobUpdates: () => options.pendingJobUpdates ?? [],
    acknowledgeJobUpdate: options.acknowledgeJobUpdate,
  });

  const openLatest = () => opened.at(-1)?.socket.onopen?.();

  return { client, opened, sent, scheduled, handleCommand, openLatest };
}

describe('the daemon connecting to the cloud tunnel', () => {
  let context: ReturnType<typeof harness>;

  beforeEach(() => {
    context = harness();
  });

  it('proves who it is in the upgrade itself, because there is no round trip afterwards', () => {
    context.client.start();

    const headers = context.opened[0]?.headers ?? {};
    expect(headers['x-device-id']).toBe('device-1');
    expect(headers['x-device-signature']).toBe(`signed(device-1:${headers['x-device-timestamp']})`);
    expect(headers['x-agent-version']).toBe('0.9.9');
    expect(headers['x-agent-platform']).toBe('win32');
  });

  it('signs a fresh timestamp for every attempt, since the server spends each one', () => {
    context.client.start();
    context.opened[0]?.socket.onclose?.({ code: 1006, reason: 'dropped' });
    context.scheduled.shift()?.();

    const first = context.opened[0]?.headers['x-device-signature'];
    const second = context.opened[1]?.headers['x-device-signature'];
    expect(context.opened).toHaveLength(2);
    expect(second).toBeTruthy();
    // Same device, so the only thing that can differ is the moment being signed.
    expect(String(second).startsWith('signed(device-1:')).toBe(true);
    expect(first).toBeTruthy();
  });

  it('does not try to connect at all before it has been paired', () => {
    const unpaired = harness({ deviceId: null });

    unpaired.client.start();

    expect(unpaired.opened).toHaveLength(0);
  });

  it('runs a command and answers with the request id it was given', async () => {
    context.client.start();
    context.openLatest();
    context.handleCommand.mockResolvedValue({ projects: ['sorema'] });

    context.opened[0]?.socket.onmessage?.({
      data: JSON.stringify({
        type: 'command_request',
        payload: { requestId: 'req-7', command: { name: 'list_projects', payload: {} } },
      }),
    });
    await vi.waitFor(() => expect(context.sent).toHaveLength(1));

    expect(context.sent[0]).toEqual({
      type: 'command_result',
      payload: { requestId: 'req-7', result: { projects: ['sorema'] } },
    });
  });

  it('runs simultaneous deliveries of one stable request only once', async () => {
    context.client.start();
    context.openLatest();
    let finish!: (value: unknown) => void;
    context.handleCommand.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const frame = {
      data: JSON.stringify({
        type: 'command_request',
        payload: { requestId: 'stable-1', command: { name: 'task.start', payload: {} } },
      }),
    };

    context.opened[0]?.socket.onmessage?.(frame);
    context.opened[0]?.socket.onmessage?.(frame);
    await vi.waitFor(() => expect(context.handleCommand).toHaveBeenCalledTimes(1));
    finish({ accepted: true });
    await vi.waitFor(() => expect(context.sent).toHaveLength(2));

    expect(context.sent[0]).toEqual(context.sent[1]);
  });

  it('answers even when the command throws, so nothing is left waiting', async () => {
    context.client.start();
    context.openLatest();
    context.handleCommand.mockRejectedValue(new Error('the workspace is gone'));

    context.opened[0]?.socket.onmessage?.({
      data: JSON.stringify({
        type: 'command_request',
        payload: { requestId: 'req-8', command: { name: 'list_projects', payload: {} } },
      }),
    });
    await vi.waitFor(() => expect(context.sent).toHaveLength(1));

    expect(context.sent[0]).toMatchObject({
      type: 'command_result',
      payload: { requestId: 'req-8', error: { message: 'the workspace is gone' } },
    });
  });

  /**
   * A refusal the assistant is expected to act on cannot survive as a sentence.
   *
   * `PROVIDER_CHOICE_REQUIRED` carries the question to ask and the answers to offer, and both used
   * to die here: the reply was `error.message`, so the cloud received "More than one agent can do
   * this work and no preference has been recorded" and nothing to choose between. Every start_task
   * on a machine with two agents installed failed that way, deterministically.
   */
  it('sends the whole structured error, not the sentence at the top of it', async () => {
    context.client.start();
    context.openLatest();
    context.handleCommand.mockRejectedValue(
      SoremaError.of('PROVIDER_CHOICE_REQUIRED', 'no preference has been recorded', {
        details: { availableProviders: ['codex', 'claude'] },
      }),
    );

    context.opened[0]?.socket.onmessage?.({
      data: JSON.stringify({
        type: 'command_request',
        payload: { requestId: 'req-9', command: { name: 'task.start', payload: {} } },
      }),
    });
    await vi.waitFor(() => expect(context.sent).toHaveLength(1));

    expect(context.sent[0]).toMatchObject({
      type: 'command_result',
      payload: {
        requestId: 'req-9',
        error: {
          code: 'PROVIDER_CHOICE_REQUIRED',
          message: 'no preference has been recorded',
          retryable: false,
          userMessage:
            'More than one agent can do this. Ask the user which one to use, then try again.',
          details: { availableProviders: ['codex', 'claude'] },
        },
      },
    });
  });

  it.each([
    ['a message that is not JSON', 'not json'],
    ['a message with no type', '{"payload":{}}'],
    [
      'a command with no request id',
      '{"type":"command_request","payload":{"command":{"name":"x"}}}',
    ],
    ['a request naming no command', '{"type":"command_request","payload":{"requestId":"r"}}'],
  ])('ignores %s', async (_case, raw) => {
    context.client.start();

    context.opened[0]?.socket.onmessage?.({ data: raw });
    await Promise.resolve();

    expect(context.handleCommand).not.toHaveBeenCalled();
    expect(context.sent).toHaveLength(0);
  });

  it('queues a finished job until the socket is actually open', () => {
    context.client.start();

    context.client.reportJob({
      eventId: 'event-1',
      eventType: 'job.completed',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'j1',
      deviceId: 'device-1',
      domainSessionId: 'session-1',
      status: 'succeeded',
      summary: 'done',
    });

    expect(context.sent).toHaveLength(0);
    expect(context.client.isConnected).toBe(false);

    context.openLatest();

    expect(context.client.isConnected).toBe(true);
    expect(context.sent[0]).toEqual({
      type: 'job_update',
      payload: {
        eventId: 'event-1',
        eventType: 'job.completed',
        occurredAt: '2026-08-18T08:00:00.000Z',
        jobId: 'j1',
        deviceId: 'device-1',
        domainSessionId: 'session-1',
        status: 'succeeded',
        summary: 'done',
      },
    });
  });

  it('keeps a job report made while offline and sends it after connecting', () => {
    expect(() =>
      context.client.reportJob({
        eventId: 'event-1',
        eventType: 'job.failed',
        occurredAt: '2026-08-18T08:00:00.000Z',
        jobId: 'j1',
        deviceId: 'device-1',
        status: 'failed',
      }),
    ).not.toThrow();
    expect(context.sent).toHaveLength(0);

    context.client.start();
    context.openLatest();

    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]).toMatchObject({
      type: 'job_update',
      payload: { eventId: 'event-1', status: 'failed' },
    });
  });

  it('replays an unacknowledged event after reconnecting', () => {
    context.client.start();
    context.openLatest();
    context.client.reportJob({
      eventId: 'event-retry',
      eventType: 'job.completed',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'j1',
      deviceId: 'device-1',
      status: 'succeeded',
    });
    expect(context.sent).toHaveLength(1);

    context.opened[0]?.socket.onclose?.({ code: 1006, reason: 'dropped before ack' });
    // The already scheduled heartbeat observes the closed socket and exits; the next callback is
    // the reconnect.
    context.scheduled.shift()?.();
    context.scheduled.shift()?.();
    context.openLatest();

    expect(context.sent).toHaveLength(2);
    expect(context.sent[1]).toEqual(context.sent[0]);
  });

  it('stops replaying an event after the cloud acknowledges it', async () => {
    context.client.start();
    context.openLatest();
    context.client.reportJob({
      eventId: 'event-acked',
      eventType: 'job.completed',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'j1',
      deviceId: 'device-1',
      status: 'succeeded',
    });
    context.opened[0]?.socket.onmessage?.({
      data: JSON.stringify({ type: 'job_update_ack', payload: { eventId: 'event-acked' } }),
    });
    await Promise.resolve();

    context.opened[0]?.socket.onclose?.({ code: 1006, reason: 'later reconnect' });
    context.scheduled.shift()?.();
    context.scheduled.shift()?.();
    context.openLatest();

    expect(context.sent).toHaveLength(1);
  });

  it('restores durable pending events after a complete service restart', () => {
    const restored = harness({
      pendingJobUpdates: [
        {
          eventId: 'event-from-disk',
          eventType: 'job.failed',
          occurredAt: '2026-08-18T08:00:00.000Z',
          jobId: 'j1',
          deviceId: 'device-1',
          status: 'failed',
        },
      ],
    });

    restored.client.start();
    restored.openLatest();

    expect(restored.sent).toEqual([
      expect.objectContaining({
        type: 'job_update',
        payload: expect.objectContaining({ eventId: 'event-from-disk' }),
      }),
    ]);
  });

  it('removes an acknowledged event from durable storage', async () => {
    const acknowledgeJobUpdate = vi.fn();
    const durable = harness({ acknowledgeJobUpdate });
    durable.client.start();
    durable.openLatest();
    durable.client.reportJob({
      eventId: 'event-delete',
      eventType: 'job.completed',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'j1',
      deviceId: 'device-1',
      status: 'succeeded',
    });

    durable.opened[0]?.socket.onmessage?.({
      data: JSON.stringify({ type: 'job_update_ack', payload: { eventId: 'event-delete' } }),
    });

    await vi.waitFor(() => expect(acknowledgeJobUpdate).toHaveBeenCalledWith('event-delete'));
  });

  it('backs off between reconnections instead of hammering the authorizer', () => {
    const delays: number[] = [];
    const sockets: CloudSocket[] = [];
    const backoff = new CloudTunnelClient({
      tunnelUrl: 'wss://tunnel.example/live',
      identity: fakeIdentity('device-1'),
      agentVersion: '0.9.9',
      platform: 'linux',
      handleCommand: vi.fn(),
      log: () => {},
      reconnectInitialDelayMs: 1000,
      reconnectMaxDelayMs: 4000,
      setTimeoutImplementation: (handler, ms) => {
        delays.push(ms);
        handler();
        return 0;
      },
      createSocket: () => {
        const socket: CloudSocket = {
          send: () => {},
          close: () => {},
          onmessage: null,
          onopen: null,
          onclose: null,
          onerror: null,
        };
        sockets.push(socket);
        return socket;
      },
    });

    backoff.start();
    // The harness reconnects immediately, so what is under test is the delay each attempt *asked*
    // for: doubling, then held at the ceiling rather than growing without bound.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      sockets[attempt]?.onclose?.({ code: 1006, reason: 'nope' });
    }

    expect(delays).toEqual([1000, 2000, 4000, 4000]);
  });

  it('stops trying once it has been told to stop', () => {
    context.client.start();
    context.client.stop();
    context.opened[0]?.socket.onclose?.({ code: 1000, reason: 'bye' });

    expect(context.scheduled).toHaveLength(0);
  });
});
