import { loadEnvironmentFiles, loadLocalAgentConfig } from '@sorema/config';
import { buildLocalAgent } from './agent.js';

loadEnvironmentFiles(process.cwd());

const agent = buildLocalAgent(loadLocalAgentConfig());

if (!agent.identity.isPaired) {
  agent.logger.warn(
    'This local agent is not paired yet. Run "pnpm pair" from the repository root to pair it with the gateway.',
  );
}

async function shutdown(signal: string): Promise<void> {
  agent.logger.info({ signal }, 'shutting down local agent');
  await agent.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await agent.start();
