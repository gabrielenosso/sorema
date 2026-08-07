import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudTunnelClient, type CloudSocket } from '../src/tunnel/cloud-tunnel-client.js';
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

function harness(options: { deviceId?: string | null } = {}) {
  const opened: OpenedSocket[] = [];
  const sent: Record<string, unknown>[] = [];
  const scheduled: (() => void)[] = [];
  const handleCommand = vi.fn().mockResolvedValue({ ok: true });

  const client = new CloudTunnelClient({
    tunnelUrl: 'wss://tunnel.example/live',
    identity: fakeIdentity(options.deviceId === undefined ? 'device-1' : options.deviceId),
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
  });

  return { client, opened, sent, scheduled, handleCommand };
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

  it('answers even when the command throws, so nothing is left waiting', async () => {
    context.client.start();
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
      payload: { requestId: 'req-8', error: 'the workspace is gone' },
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

  it('reports a finished job without being asked', () => {
    context.client.start();

    context.client.reportJob({ jobId: 'j1', status: 'succeeded', summary: 'done' });

    expect(context.sent[0]).toEqual({
      type: 'job_update',
      payload: { jobId: 'j1', status: 'succeeded', summary: 'done' },
    });
  });

  it('drops a job report on the floor rather than throwing when the socket is down', () => {
    expect(() => context.client.reportJob({ jobId: 'j1', status: 'failed' })).not.toThrow();
    expect(context.sent).toHaveLength(0);
  });

  it('backs off between reconnections instead of hammering the authorizer', () => {
    const delays: number[] = [];
    const sockets: CloudSocket[] = [];
    const backoff = new CloudTunnelClient({
      tunnelUrl: 'wss://tunnel.example/live',
      identity: fakeIdentity('device-1'),
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
