import { platform } from 'node:os';
import {
  loadEnvironmentFiles,
  loadGatewayConfig,
  loadLocalAgentConfig,
  resolveFromWorkspaceRoot,
} from '@sorema/config';
import { DeviceIdentityStore } from '../identity/device-identity-store.js';
import { LOCAL_AGENT_VERSION } from '../capabilities/capability-detector.js';

loadEnvironmentFiles(process.cwd());

const gatewayConfig = loadGatewayConfig();
const localAgentConfig = loadLocalAgentConfig();
const identity = new DeviceIdentityStore(resolveFromWorkspaceRoot(localAgentConfig.stateDirectory));

if (identity.isPaired) {
  console.warn(`Already paired. deviceId=${identity.deviceId} userId=${identity.userId}`);
  console.warn('Delete device-identity.json in the state directory to pair again.');
  process.exit(0);
}

const baseUrl = localAgentConfig.gatewayHttpUrl.replace(/\/$/, '');

const createResponse = await fetch(`${baseUrl}/api/pairing/create`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${gatewayConfig.clientAccessToken}`,
    'content-type': 'application/json',
  },
  body: '{}',
});

if (!createResponse.ok) {
  console.error(`Could not create a pairing code: HTTP ${createResponse.status}`);
  console.error(await createResponse.text());
  process.exit(1);
}

const { pairingCode } = (await createResponse.json()) as { pairingCode: string };
console.warn(`Pairing code issued: ${pairingCode}`);

const claimResponse = await fetch(`${baseUrl}/api/pairing/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    code: pairingCode,
    deviceName: localAgentConfig.deviceName,
    publicKeyPem: identity.publicKeyPem,
    platform: platform(),
    agentVersion: LOCAL_AGENT_VERSION,
  }),
});

if (!claimResponse.ok) {
  console.error(`Pairing failed: HTTP ${claimResponse.status}`);
  console.error(await claimResponse.text());
  process.exit(1);
}

const claimed = (await claimResponse.json()) as { deviceId: string; userId: string };
identity.recordPairing(claimed.deviceId, claimed.userId);

console.warn(`Paired. deviceId=${claimed.deviceId} userId=${claimed.userId}`);
console.warn('The local agent will authenticate automatically the next time it connects.');
