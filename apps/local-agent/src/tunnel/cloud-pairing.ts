import type { DeviceIdentityStore } from '../identity/device-identity-store.js';

export type PairingResult = { deviceId: string; userId: string };

/**
 * Turns a code the user reads off the web page into a lasting identity for this machine.
 *
 * The code is the only credential the daemon has at this point, and it is sent once. What comes back
 * is a device id; what stays here is the private key, which was generated locally and never leaves.
 * The cloud only ever learns the public half, so a breach there cannot impersonate this machine.
 */
export async function pairWithCode(
  apiBaseUrl: string,
  code: string,
  identity: DeviceIdentityStore,
  deviceName: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PairingResult> {
  // Separators stripped, because the browser shows some codes grouped and nobody retypes a code
  // without its dash. The check that follows is a length and shape check only: this repository
  // holds two pairing-code alphabets, and a client that insisted on one of them would turn away
  // every code the day the other went live. Whether a code is real is the service's answer, not
  // ours — all this catches is a typo, before it costs a round trip.
  const trimmed = code.trim().replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{8}$/.test(trimmed)) {
    throw new Error('a pairing code is eight characters, as shown in the browser');
  }

  const response = await fetchImplementation(`${apiBaseUrl.replace(/\/$/, '')}/pair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${trimmed}`, 'content-type': 'application/json' },
    body: JSON.stringify({ publicKeyPem: identity.publicKeyPem, name: deviceName }),
  });

  if (response.status === 403 || response.status === 401) {
    throw new Error('that code is not valid any more — ask the browser for a new one');
  }
  if (response.status === 409) {
    throw new Error('that code has already been used by another machine');
  }
  if (!response.ok) {
    throw new Error(`pairing failed with HTTP ${response.status}`);
  }

  const paired = (await response.json()) as Partial<PairingResult>;
  if (!paired.deviceId || !paired.userId) throw new Error('the pairing reply made no sense');

  identity.recordPairing(paired.deviceId, paired.userId);
  return { deviceId: paired.deviceId, userId: paired.userId };
}
