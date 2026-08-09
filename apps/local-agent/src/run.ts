import { loadEnvironmentFiles, loadLocalAgentConfig } from '@sorema/config';
import { buildLocalAgent } from './agent.js';

/**
 * Starts the agent and stays running until the process is asked to stop.
 *
 * Separate from `index.ts` so that the packaged command can call it. A module that starts a daemon
 * as a side effect of being imported cannot be reused by anything.
 */
export async function runAgent(): Promise<void> {
  loadEnvironmentFiles(process.cwd());
  const agent = buildLocalAgent(loadLocalAgentConfig());

  if (!agent.identity.isPaired) {
    agent.logger.warn('This machine is not paired yet. Run "sorema pair <CODE>" first.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    agent.logger.info({ signal }, 'shutting down');
    await agent.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await agent.start();

  // Never resolves. `agent.start()` returns as soon as everything is listening, and the caller then
  // treats that as the work being done: the packaged command reached `process.exit(0)` about a
  // millisecond later and killed the agent before its socket had finished connecting. Every machine
  // paired this way reported itself never connected, while the log said "listening" on the way out,
  // which read like success. Only a signal ends this, through the handlers above.
  await new Promise<never>(() => {});
}
