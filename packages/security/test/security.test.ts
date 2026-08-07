import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAuthenticationChallenge,
  fingerprintPublicKey,
  generateDeviceKeyPair,
  generatePairingCode,
  hashPairingCode,
  isPathWithinRoot,
  issueDeviceSessionToken,
  normalizePairingCode,
  redactSecrets,
  resolveWithinAllowedRoots,
  signChallenge,
  truncateOutput,
  verifyChallengeSignature,
  verifyDeviceSessionToken,
} from '../src/index.js';

describe('device identity', () => {
  it('signs a challenge that verifies with the matching public key', () => {
    const keyPair = generateDeviceKeyPair();
    const challenge = createAuthenticationChallenge();
    const signature = signChallenge(challenge, keyPair.privateKeyPem);
    expect(verifyChallengeSignature(challenge, signature, keyPair.publicKeyPem)).toBe(true);
  });

  it('rejects a signature produced by a different device', () => {
    const trusted = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();
    const challenge = createAuthenticationChallenge();
    const signature = signChallenge(challenge, attacker.privateKeyPem);
    expect(verifyChallengeSignature(challenge, signature, trusted.publicKeyPem)).toBe(false);
  });

  it('rejects a signature for a different challenge', () => {
    const keyPair = generateDeviceKeyPair();
    const signature = signChallenge(createAuthenticationChallenge(), keyPair.privateKeyPem);
    expect(
      verifyChallengeSignature(createAuthenticationChallenge(), signature, keyPair.publicKeyPem),
    ).toBe(false);
  });

  it('produces a stable fingerprint per public key', () => {
    const keyPair = generateDeviceKeyPair();
    expect(fingerprintPublicKey(keyPair.publicKeyPem)).toBe(
      fingerprintPublicKey(keyPair.publicKeyPem),
    );
    expect(fingerprintPublicKey(keyPair.publicKeyPem)).not.toBe(
      fingerprintPublicKey(generateDeviceKeyPair().publicKeyPem),
    );
  });
});

describe('pairing codes', () => {
  it('hashes the same code regardless of formatting', () => {
    const code = generatePairingCode();
    expect(normalizePairingCode(code)).toHaveLength(8);
    expect(hashPairingCode(code)).toBe(hashPairingCode(code.toLowerCase().replace('-', ' ')));
  });

  it('produces different hashes for different codes', () => {
    expect(hashPairingCode(generatePairingCode())).not.toBe(hashPairingCode(generatePairingCode()));
  });
});

describe('device session tokens', () => {
  const secret = 'a-very-long-testing-secret-value';

  it('issues a token that verifies before it expires', () => {
    const { token } = issueDeviceSessionToken({ userId: 'u1', deviceId: 'd1' }, secret, 60);
    expect(verifyDeviceSessionToken(token, secret)?.deviceId).toBe('d1');
  });

  it('rejects an expired token', () => {
    const { token } = issueDeviceSessionToken({ userId: 'u1', deviceId: 'd1' }, secret, 1, 1_000);
    expect(verifyDeviceSessionToken(token, secret, 2_000)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const { token } = issueDeviceSessionToken({ userId: 'u1', deviceId: 'd1' }, secret, 60);
    expect(verifyDeviceSessionToken(token, 'another-secret-that-is-long')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const { token } = issueDeviceSessionToken({ userId: 'u1', deviceId: 'd1' }, secret, 60);
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        userId: 'u1',
        deviceId: 'other-device',
        issuedAtSeconds: 1,
        expiresAtSeconds: 9_999_999_999,
      }),
    ).toString('base64url');
    expect(verifyDeviceSessionToken(`${forgedPayload}.${signature}`, secret)).toBeNull();
  });
});

describe('workspace path safety', () => {
  const root = mkdtempSync(join(tmpdir(), 'sorema-workspace-'));
  mkdirSync(join(root, 'project-a'), { recursive: true });
  writeFileSync(join(root, 'project-a', 'readme.md'), 'hello');
  const outside = mkdtempSync(join(tmpdir(), 'sorema-outside-'));

  it('accepts a path inside an allowed root', () => {
    expect(resolveWithinAllowedRoots(join(root, 'project-a'), [root])).toBeTruthy();
  });

  it('blocks path traversal out of the root', () => {
    expect(() => resolveWithinAllowedRoots(join(root, 'project-a', '..', '..'), [root])).toThrow(
      /outside the allowed workspace roots/,
    );
  });

  it('blocks an unrelated absolute directory', () => {
    expect(() => resolveWithinAllowedRoots(outside, [root])).toThrow(
      /outside the allowed workspace roots/,
    );
  });

  it('blocks everything when no roots are configured', () => {
    expect(() => resolveWithinAllowedRoots(root, [])).toThrow(/No workspace roots/);
  });

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(isPathWithinRoot(`${resolve(root)}-sibling`, root)).toBe(false);
  });
});

describe('log hygiene', () => {
  it('redacts api keys and bearer style secrets', () => {
    const redacted = redactSecrets(
      'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx and token: ghp_abcdefghijklmnopqrst',
    );
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrst');
  });

  it('truncates oversized output', () => {
    const truncated = truncateOutput('x'.repeat(1_000), 100);
    expect(truncated).toContain('[output truncated at 100 bytes]');
    expect(truncated.length).toBeLessThan(200);
  });
});
