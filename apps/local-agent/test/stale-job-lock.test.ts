import { describe, expect, it } from 'vitest';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore } from '../src/store/local-store.js';

/**
 * A project blocked for ever by a job nobody can finish.
 *
 * `withProjectStartLock` refuses a second agent in the same working tree, which is right: two agents
 * editing the same files is how somebody loses work. It asks the store whether a job is active, and
 * a job whose provider died without ever emitting a terminal event stays `running` for as long as
 * the daemon keeps running. Every later attempt on that project is then refused, and from a voice
 * conversation there is no way out at all — which is exactly what a whole session of "il primo
 * tentativo è fallito" was.
 *
 * A restart clears them, and a machine left on for a week does not restart. So the lock now ignores
 * a job that began longer ago than a job is allowed to take.
 */
function storeWithJob(status: string, updatedMinutesAgo: number): LocalStore {
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const updatedAt = new Date(Date.now() - updatedMinutesAgo * 60_000).toISOString();
  store.saveDomainSession({
    id: 'session-1',
    domain: 'coding',
    userId: 'user-1',
    deviceId: 'device-1',
    providerId: 'claude',
    projectPath: 'C:/code/project',
    title: 'a session',
    status: 'idle',
    metadata: {},
    createdAt: updatedAt,
    updatedAt,
  });
  store.saveJob({
    id: 'job-1',
    domainSessionId: 'session-1',
    userId: 'user-1',
    deviceId: 'device-1',
    domain: 'coding',
    type: 'coding.task',
    providerId: 'claude',
    instruction: 'do the thing',
    status,
    createdAt: updatedAt,
    updatedAt,
    idempotencyKey: 'key-1',
    correlationId: 'corr-1',
  } as never);
  return store;
}

describe('what still counts as work in progress', () => {
  it('blocks a second agent while a job is genuinely running', () => {
    const store = storeWithJob('running', 1);

    expect(store.findActiveJobForProject('C:/code/project', 'user-1', 'device-1')).not.toBeNull();
  });

  it('stops blocking once a job began longer ago than one is allowed to take', () => {
    const store = storeWithJob('running', 60);

    expect(store.findActiveJobForProject('C:/code/project', 'user-1', 'device-1')).toBeNull();
  });

  it('leaves a finished job out of it either way', () => {
    const store = storeWithJob('succeeded', 1);

    expect(store.findActiveJobForProject('C:/code/project', 'user-1', 'device-1')).toBeNull();
  });
});
