import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBuffer,
  timingSafeEqual,
  verify as verifyBuffer,
} from 'node:crypto';

export type DeviceKeyPair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function createAuthenticationChallenge(): string {
  return randomBytes(32).toString('base64url');
}

export function signChallenge(challenge: string, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return signBuffer(null, Buffer.from(challenge, 'utf8'), privateKey).toString('base64url');
}

export function verifyChallengeSignature(
  challenge: string,
  signatureBase64Url: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    return verifyBuffer(
      null,
      Buffer.from(challenge, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64Url, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
