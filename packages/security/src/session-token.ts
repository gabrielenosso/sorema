import { createHmac } from 'node:crypto';
import { constantTimeEquals } from './device-identity.js';

export type DeviceSessionTokenPayload = {
  userId: string;
  deviceId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
};

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function computeSignature(payloadSegment: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

export function issueDeviceSessionToken(
  payload: Omit<DeviceSessionTokenPayload, 'issuedAtSeconds' | 'expiresAtSeconds'>,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { token: string; expiresAtSeconds: number } {
  const fullPayload: DeviceSessionTokenPayload = {
    ...payload,
    issuedAtSeconds: nowSeconds,
    expiresAtSeconds: nowSeconds + ttlSeconds,
  };
  const segment = encodeSegment(fullPayload);
  return {
    token: `${segment}.${computeSignature(segment, secret)}`,
    expiresAtSeconds: fullPayload.expiresAtSeconds,
  };
}

export function verifyDeviceSessionToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeviceSessionTokenPayload | null {
  const [segment, signature] = token.split('.');
  if (!segment || !signature) return null;
  if (!constantTimeEquals(signature, computeSignature(segment, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof payload?.expiresAtSeconds !== 'number') return null;
    if (payload.expiresAtSeconds <= nowSeconds) return null;
    return payload as DeviceSessionTokenPayload;
  } catch {
    return null;
  }
}
