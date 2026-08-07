import { hostname, platform } from 'node:os';
import {
  loadEnvironmentFiles,
  loadLocalAgentConfig,
  resolveFromWorkspaceRoot,
} from '@sorema/config';
import { DeviceIdentityStore } from '../identity/device-identity-store.js';
import { pairWithCode } from '../tunnel/cloud-pairing.js';

loadEnvironmentFiles(process.cwd());

const apiBaseUrl = process.env.SOREMA_API_URL ?? '';
const code = process.argv[2] ?? '';

if (!apiBaseUrl) {
  console.error('Set SOREMA_API_URL to the deployment you are pairing with.');
  process.exit(1);
}
if (!code) {
  console.error('Usage: pnpm pair:cloud <CODE>');
  console.error('Get the code from the web app, under "Pair your computer".');
  process.exit(1);
}

const identity = new DeviceIdentityStore(
  resolveFromWorkspaceRoot(loadLocalAgentConfig().stateDirectory),
);

if (identity.isPaired) {
  console.warn(`Already paired as ${identity.deviceId}.`);
  console.warn('Delete device-identity.json in the state directory to pair again.');
  process.exit(0);
}

try {
  const paired = await pairWithCode(apiBaseUrl, code, identity, `${hostname()} (${platform()})`);
  console.warn(`Paired. deviceId=${paired.deviceId}`);
  console.warn('The private key stays on this machine; only its public half was sent.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
