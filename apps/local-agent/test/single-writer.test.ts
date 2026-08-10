import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localAgentConfigSchema } from '@sorema/config';
import { nowIsoTimestamp } from '@sorema/domain-model';
import { buildLocalAgent, type LocalAgent } from '../src/agent.js';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore, type LocalJob } from '../src/store/local-store.js';

const started: LocalAgent[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

function configurationFor(directory: string, port: number) {
  return localAgentConfigSchema.parse({
    // Deliberately no tunnel address: this is about two processes on one machine, and a socket
    // trying to reach a deployment would only add a way for the test to be slow and flaky.
    cloudTunnelUrl: '',
    loopbackPort: port,
    stateDirectory: directory,
    databaseUrl: `file:${join(directory, 'sorema.sqlite')}`,
    logLevel: 'fatal',
  });
}

function runningJob(): LocalJob {
  const timestamp = nowIsoTimestamp();
  return {
    id: 'job_in_flight',
    userId: 'user_1',
    deviceId: 'dev_1',
    domain: 'coding',
    type: 'coding.task',
    status: 'running',
    createdAt: timestamp,
    startedAt: timestamp,
    idempotencyKey: 'idem_1',
    correlationId: 'corr_1',
    instruction: 'a task that is happening right now',
    providerId: 'fake',
  };
}

/**
 * Two agents, one machine.
 *
 * `sorema start` typed by hand while the installed service is running is an ordinary thing to do,
 * and it used to cost the user the work in flight: the second instance marked every unfinished job
 * as interrupted — the service's jobs, in the service's database — told the cloud they had failed,
 * and only then found the port taken and gave up. It damaged and left.
 *
 * The fix is ordering, not locking: claim the address first and the loser is a process that never
 * wrote anything, which is a property of the code rather than of anybody remembering.
 */
describe('a second agent started beside a running one', () => {
  it('refuses, and leaves the running agent’s jobs alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sorema-single-writer-'));
    // Its own port, because the developer running this very likely has the real agent installed and
    // listening on the default one.
    const port = 26_000 + (process.pid % 4_000);
    const configuration = configurationFor(directory, port);

    const service = buildLocalAgent(configuration);
    started.push(service);
    await service.start();
    service.store.saveJob(runningJob());

    const byHand = buildLocalAgent(configuration);
    started.push(byHand);
    await expect(byHand.start()).rejects.toThrow(/EADDRINUSE|address already in use/i);

    // Read through a third connection, so the answer comes off the file rather than out of either
    // agent's own handle on it.
    const onDisk = new LocalStore(
      createLocalAgentDatabase(`file:${join(directory, 'sorema.sqlite')}`),
    );
    expect(onDisk.findJob('job_in_flight')?.status).toBe('running');
    expect(onDisk.findJob('job_in_flight')?.completedAt).toBeUndefined();
    expect(onDisk.listUnfinishedJobs()).toHaveLength(1);
  });

  it('still marks the jobs a real restart left behind, which is what that pass is for', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sorema-single-writer-'));
    const port = 26_000 + ((process.pid + 1) % 4_000);
    const configuration = configurationFor(directory, port);

    const before = buildLocalAgent(configuration);
    before.store.saveJob(runningJob());
    await before.close();

    const after = buildLocalAgent(configuration);
    started.push(after);
    await after.start();

    // The port is claimed first now, so this has to be asserted separately or the ordering change
    // could silently be "never mark anything again", which is the same bug from the other side.
    expect(after.store.findJob('job_in_flight')?.status).toBe('interrupted');
  });
});
