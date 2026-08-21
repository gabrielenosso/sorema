import { describe, expect, it, vi } from 'vitest';
import { pairWithCode } from '../src/tunnel/cloud-pairing.js';
import type { DeviceIdentityStore } from '../src/identity/device-identity-store.js';

function fakeIdentity() {
  const recorded: { deviceId?: string; userId?: string } = {};
  const identity = {
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----',
    recordPairing: (deviceId: string, userId: string) => {
      recorded.deviceId = deviceId;
      recorded.userId = userId;
    },
  } as unknown as DeviceIdentityStore;
  return { identity, recorded };
}

function reply(status: number, body: unknown = {}) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe('pairing this machine with a code from the browser', () => {
  it('sends the public half of the key and nothing else', async () => {
    const { identity } = fakeIdentity();
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(reply(201, { deviceId: 'device-1', userId: 'user-1' }));

    await pairWithCode('https://api.example', 'A1B2C3D4', identity, 'laptop', fetchImplementation);

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example/pair');
    expect(init.headers.authorization).toBe('Bearer A1B2C3D4');
    expect(String(init.body)).toContain('PUBLIC');
    expect(String(init.body)).not.toContain('PRIVATE');
  });

  it('remembers the identity it was given', async () => {
    const { identity, recorded } = fakeIdentity();

    await pairWithCode(
      'https://api.example',
      'a1b2c3d4',
      identity,
      'laptop',
      vi.fn().mockResolvedValue(reply(201, { deviceId: 'device-9', userId: 'user-9' })),
    );

    expect(recorded).toEqual({ deviceId: 'device-9', userId: 'user-9' });
  });

  it('accepts the code in whatever case it was typed', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(reply(201, { deviceId: 'd', userId: 'u' }));

    await pairWithCode(
      'https://api.example',
      ' a1b2c3d4 ',
      fakeIdentity().identity,
      'laptop',
      fetchImplementation,
    );

    expect(fetchImplementation.mock.calls[0]?.[1]?.headers.authorization).toBe('Bearer A1B2C3D4');
  });

  it.each(['6D246143', 'KQZM-W7PT', 'kqzmw7pt'])(
    'sends both alphabets to the server (%s)',
    async (code) => {
      const { identity } = fakeIdentity();
      const fetchImplementation = vi
        .fn()
        .mockResolvedValue(reply(201, { deviceId: 'device-1', userId: 'user-1' }));

      await pairWithCode('https://api.example', code, identity, 'a machine', fetchImplementation);

      const [, init] = fetchImplementation.mock.calls[0] ?? [];
      expect(String(init.headers.authorization)).toMatch(/^Bearer [0-9A-Z]{8}$/);
    },
  );

  it.each([
    ['too short', 'A1B2'],
    ['punctuated', 'A1B2*C3D'],
    ['empty', ''],
  ])('refuses a code that is %s without asking the server', async (_case, code) => {
    // Note what is missing: no case here rejects a code for using the wrong letters. This test used
    // to demand hexadecimal, which is one of the two alphabets in this repository, and a client
    // enforcing one of them turns away every code the day the other goes live. Length and shape are
    // ours to check; the alphabet belongs to whoever issues the codes.
    const fetchImplementation = vi.fn();

    await expect(
      pairWithCode(
        'https://api.example',
        code,
        fakeIdentity().identity,
        'laptop',
        fetchImplementation,
      ),
    ).rejects.toThrow(/eight characters/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['expired or wrong', 403, /not valid any more/],
    ['already spent', 409, /already been used/],
  ])('explains a code that is %s', async (_case, status, expected) => {
    await expect(
      pairWithCode(
        'https://api.example',
        'A1B2C3D4',
        fakeIdentity().identity,
        'laptop',
        vi.fn().mockResolvedValue(reply(status)),
      ),
    ).rejects.toThrow(expected);
  });

  it('does not record a pairing the server never confirmed', async () => {
    const { identity, recorded } = fakeIdentity();

    await expect(
      pairWithCode(
        'https://api.example',
        'A1B2C3D4',
        identity,
        'laptop',
        vi.fn().mockResolvedValue(reply(201, { deviceId: 'device-1' })),
      ),
    ).rejects.toThrow();
    expect(recorded).toEqual({});
  });
});
