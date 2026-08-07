import { createHash, randomInt } from 'node:crypto';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;

export function generatePairingCode(): string {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashPairingCode(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code)).digest('hex');
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 32);
}
