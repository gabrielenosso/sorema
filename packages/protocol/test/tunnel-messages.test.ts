import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  createTunnelMessage,
  deviceCommandSchema,
  expiresInMilliseconds,
  isMessageExpired,
  isProtocolVersionSupported,
  parseDeviceCommandResult,
  safeParseTunnelMessage,
  serializeTunnelMessage,
  tunnelMessageSchema,
  type TunnelMessage,
} from '../src/index.js';

function sampleMessages(): TunnelMessage[] {
  return [
    createTunnelMessage({
      type: 'register_device',
      payload: {
        deviceId: 'dev_1',
        deviceName: 'workstation',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----',
        agentVersion: '0.1.0',
        platform: 'win32',
        capabilities: [],
      },
    }),
    createTunnelMessage({
      type: 'authentication_challenge',
      payload: { challenge: 'abc', expiresAt: new Date().toISOString() },
    }),
    createTunnelMessage({
      type: 'authentication_response',
      payload: { challenge: 'abc', signature: 'sig' },
    }),
    createTunnelMessage({
      type: 'authentication_accepted',
      payload: {
        deviceId: 'dev_1',
        userId: 'user_1',
        sessionToken: 'token',
        sessionTokenExpiresAtSeconds: 1,
        heartbeatIntervalMs: 15_000,
      },
    }),
    createTunnelMessage({
      type: 'command_request',
      payload: {
        command: { name: 'capabilities.list', payload: {} },
        idempotencyKey: 'idem_1',
      },
    }),
    createTunnelMessage({
      type: 'command_accepted',
      payload: { requestMessageId: 'msg_1' },
    }),
    createTunnelMessage({
      type: 'command_result',
      payload: {
        requestMessageId: 'msg_1',
        commandName: 'capabilities.list',
        ok: true,
        result: { capabilities: [] },
      },
    }),
    createTunnelMessage({
      type: 'event',
      payload: {
        event: {
          eventId: 'evt_1',
          type: 'job.started',
          occurredAt: new Date().toISOString(),
          userId: 'user_1',
          correlationId: 'corr_1',
          payload: { jobId: 'job_1', domain: 'coding', startedAt: new Date().toISOString() },
        },
      },
    }),
    createTunnelMessage({ type: 'ack', payload: { acknowledgedMessageId: 'msg_1' } }),
    createTunnelMessage({
      type: 'heartbeat',
      payload: { uptimeSeconds: 12, activeJobCount: 0 },
    }),
    createTunnelMessage({
      type: 'error',
      payload: {
        error: { code: 'JOB_NOT_FOUND', message: 'nope', retryable: false, userMessage: 'nope' },
      },
    }),
  ];
}

describe('tunnel protocol', () => {
  it('validates every message type in the union', () => {
    for (const message of sampleMessages()) {
      const parsed = tunnelMessageSchema.safeParse(message);
      expect(parsed.success, `${message.type} should be valid`).toBe(true);
    }
  });

  it('round-trips through serialize and parse', () => {
    for (const message of sampleMessages()) {
      const parsed = safeParseTunnelMessage(serializeTunnelMessage(message));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.message).toEqual(message);
    }
  });

  it('rejects malformed payloads instead of throwing', () => {
    const parsed = safeParseTunnelMessage(JSON.stringify({ type: 'heartbeat' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const parsed = safeParseTunnelMessage(
      JSON.stringify({
        messageId: 'm',
        protocolVersion: PROTOCOL_VERSION,
        correlationId: 'c',
        timestamp: new Date().toISOString(),
        type: 'take_over_the_machine',
        payload: {},
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects commands that are not in the catalogue', () => {
    expect(deviceCommandSchema.safeParse({ name: 'shell.exec', payload: {} }).success).toBe(false);
  });

  it('recognises only supported protocol versions', () => {
    expect(isProtocolVersionSupported(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolVersionSupported('0.0.1')).toBe(false);
  });

  it('detects expired messages', () => {
    const expired = createTunnelMessage({
      type: 'heartbeat',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      payload: { uptimeSeconds: 1, activeJobCount: 0 },
    });
    const fresh = createTunnelMessage({
      type: 'heartbeat',
      expiresAt: expiresInMilliseconds(60_000),
      payload: { uptimeSeconds: 1, activeJobCount: 0 },
    });
    expect(isMessageExpired(expired)).toBe(true);
    expect(isMessageExpired(fresh)).toBe(false);
  });

  it('parses command results against the schema of the matching command', () => {
    const result = parseDeviceCommandResult('task.start', {
      accepted: true,
      jobId: 'job_1',
      domainSessionId: 'dsn_1',
        domain: 'coding',
      providerId: 'fake',
      status: 'queued',
      spokenSummary: 'starting',
    });
    expect(result.jobId).toBe('job_1');
    expect(() => parseDeviceCommandResult('task.start', { accepted: false })).toThrow();
  });
});
