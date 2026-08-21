import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { generateDeviceKeyPair, signChallenge } from '@sorema/security';

const identityFileSchema = z.object({
  deviceId: z.string().nullable(),
  userId: z.string().nullable(),
  publicKeyPem: z.string(),
  privateKeyPem: z.string(),
  createdAt: z.string(),
});

export type DeviceIdentity = z.infer<typeof identityFileSchema>;

export const IDENTITY_FILE_NAME = 'device-identity.json';

export class DeviceIdentityStore {
  private readonly filePath: string;
  private identity: DeviceIdentity;

  constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.filePath = join(stateDirectory, IDENTITY_FILE_NAME);
    this.identity = this.loadOrCreate();
  }

  /**
   * Forgets which account this machine belongs to, and generates a fresh key.
   *
   * Pairing again means joining a different account, and the old key is one no server will
   * recognise. Keeping it would leave the machine believing it is paired while the account it claims
   * cannot see it — which is exactly what a rebuilt user pool leaves behind.
   */
  reset(): void {
    const keyPair = generateDeviceKeyPair();
    const fresh = {
      deviceId: null,
      userId: null,
      createdAt: new Date().toISOString(),
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem,
    };
    this.identity = fresh;
    this.persist(fresh);
  }

  /** A copy to put back if what comes next fails. */
  snapshot(): DeviceIdentity {
    return { ...this.identity };
  }

  restore(identity: DeviceIdentity): void {
    this.identity = identity;
    this.persist(identity);
  }

  private loadOrCreate(): DeviceIdentity {
    if (existsSync(this.filePath)) {
      const parsed = identityFileSchema.safeParse(
        JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown,
      );
      if (parsed.success) return parsed.data;
    }
    const keyPair = generateDeviceKeyPair();
    const created: DeviceIdentity = {
      deviceId: null,
      userId: null,
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem,
      createdAt: new Date().toISOString(),
    };
    this.persist(created);
    return created;
  }

  private persist(identity: DeviceIdentity): void {
    writeFileSync(this.filePath, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows filesystems may not support POSIX modes; the file stays in the user profile.
    }
    this.identity = identity;
  }

  get publicKeyPem(): string {
    return this.identity.publicKeyPem;
  }

  get deviceId(): string | null {
    return this.identity.deviceId;
  }

  get userId(): string | null {
    return this.identity.userId;
  }

  get isPaired(): boolean {
    return this.identity.deviceId !== null;
  }

  recordPairing(deviceId: string, userId: string): void {
    this.persist({ ...this.identity, deviceId, userId });
  }

  sign(challenge: string): string {
    return signChallenge(challenge, this.identity.privateKeyPem);
  }
}
