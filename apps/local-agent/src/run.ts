import { rmSync, writeFileSync } from 'node:fs';
import { agentProcessIdPath, loadEnvironmentFiles, loadLocalAgentConfig } from '@sorema/config';
import { buildLocalAgent } from './agent.js';

/**
 * Starts the agent and stays running until the process is asked to stop.
 *
 * Separate from `index.ts` so that the packaged command can call it. A module that starts a daemon
 * as a side effect of being imported cannot be reused by anything.
 */
export async function runAgent(): Promise<void> {
  loadEnvironmentFiles(process.cwd());
  const configuration = loadLocalAgentConfig();
  const agent = buildLocalAgent(configuration);
  const processIdPath = agentProcessIdPath(configuration.stateDirectory);
  let publishedProcessId = false;

  /**
   * Only ever removes a file this process wrote.
   *
   * An agent that lost the race for the loopback port exits through here too, and unconditionally
   * deleting would take away the *winner's* file — leaving the one machine that is genuinely
   * running with nothing naming it.
   */
  const withdrawProcessId = (): void => {
    if (!publishedProcessId) return;
    publishedProcessId = false;
    try {
      rmSync(processIdPath);
    } catch {
      // Somebody else clearing it first is the state asked for, not a failure.
    }
  };

  if (!agent.identity.isPaired) {
    agent.logger.warn('This machine is not paired yet. Run "sorema pair <CODE>" first.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    agent.logger.info({ signal }, 'shutting down');
    withdrawProcessId();
    await agent.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', withdrawProcessId);

  await agent.start();

  // After the port is claimed, never before. `agent.start()` binds the loopback port first, which is
  // what makes this daemon the single writer, so a file written here names the process that actually
  // holds it rather than one that is about to die on EADDRINUSE. The installer stops the agent by
  // this id on Windows, where ending the scheduled task reaches the launcher and not the agent.
  writeFileSync(processIdPath, `${process.pid}\n`, 'utf8');
  publishedProcessId = true;

  // Never resolves. `agent.start()` returns as soon as everything is listening, and the caller then
  // treats that as the work being done: the packaged command reached `process.exit(0)` about a
  // millisecond later and killed the agent before its socket had finished connecting. Every machine
  // paired this way reported itself never connected, while the log said "listening" on the way out,
  // which read like success. Only a signal ends this, through the handlers above.
  await new Promise<never>(() => {});
}
