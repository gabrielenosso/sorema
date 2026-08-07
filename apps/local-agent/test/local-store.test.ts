import { describe, expect, it } from 'vitest';
import { createEventId, nowIsoTimestamp, type SoremaEvent } from '@sorema/domain-model';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore, type LocalJob } from '../src/store/local-store.js';

function createStore(): LocalStore {
  return new LocalStore(createLocalAgentDatabase(':memory:'));
}

function jobFixture(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: 'job_1',
    userId: 'user_1',
    deviceId: 'dev_1',
    domain: 'coding',
    type: 'coding.task',
    status: 'queued',
    createdAt: nowIsoTimestamp(),
    idempotencyKey: 'idem_1',
    correlationId: 'corr_1',
    instruction: 'do the thing',
    providerId: 'fake',
    ...overrides,
  };
}

function eventFixture(eventId = createEventId()): SoremaEvent {
  return {
    eventId,
    type: 'job.completed',
    occurredAt: nowIsoTimestamp(),
    userId: 'user_1',
    deviceId: 'dev_1',
    correlationId: 'corr_1',
    payload: {
      jobId: 'job_1',
      domain: 'coding',
      summary: 'done',
      spokenSummary: 'done',
      completedAt: nowIsoTimestamp(),
    },
  };
}

describe('local job storage', () => {
  it('saves and reads a job, preserving fractional progress', () => {
    const store = createStore();
    store.saveJob(jobFixture({ status: 'running', progress: 0.45 }));
    const stored = store.findJob('job_1');
    expect(stored?.status).toBe('running');
    expect(stored?.progress).toBeCloseTo(0.45, 2);
  });

  it('updates a job on conflict instead of duplicating it', () => {
    const store = createStore();
    store.saveJob(jobFixture());
    store.saveJob(jobFixture({ status: 'completed', summary: 'finished' }));
    expect(store.listJobs()).toHaveLength(1);
    expect(store.findJob('job_1')?.summary).toBe('finished');
  });

  it('filters active jobs', () => {
    const store = createStore();
    store.saveJob(jobFixture({ id: 'job_running', status: 'running' }));
    store.saveJob(jobFixture({ id: 'job_done', status: 'completed' }));
    expect(store.listJobs({ activeOnly: true }).map((job) => job.id)).toEqual(['job_running']);
  });
});

describe('persistent outbox', () => {
  it('queues an event and reports it as due', () => {
    const store = createStore();
    store.enqueueOutboxEvent(eventFixture());
    expect(store.listDueOutboxEntries()).toHaveLength(1);
    expect(store.countPendingOutboxEntries()).toBe(1);
  });

  it('deduplicates by eventId', () => {
    const store = createStore();
    const event = eventFixture('evt_stable');
    store.enqueueOutboxEvent(event);
    store.enqueueOutboxEvent(event);
    expect(store.countPendingOutboxEntries()).toBe(1);
  });

  it('stops redelivering once acknowledged', () => {
    const store = createStore();
    const event = eventFixture('evt_ack');
    store.enqueueOutboxEvent(event);
    store.acknowledgeOutboxEvent('evt_ack');
    expect(store.listDueOutboxEntries()).toHaveLength(0);
    expect(store.countPendingOutboxEntries()).toBe(0);
  });

  it('never schedules an immediate retry, so an unacknowledged event cannot busy-loop', () => {
    const store = createStore();
    store.enqueueOutboxEvent(eventFixture('evt_backoff'));
    store.recordOutboxDeliveryAttempt('evt_backoff', 0);
    expect(store.listDueOutboxEntries(25, new Date(Date.now() + 500))).toHaveLength(0);
    expect(store.listDueOutboxEntries(25, new Date(Date.now() + 2_000))).toHaveLength(1);
  });

  it('waits longer after each successive attempt', () => {
    const store = createStore();
    store.enqueueOutboxEvent(eventFixture('evt_backoff'));
    store.recordOutboxDeliveryAttempt('evt_backoff', 3);
    expect(store.listDueOutboxEntries(25, new Date(Date.now() + 30_000))).toHaveLength(0);
    const laterEntries = store.listDueOutboxEntries(25, new Date(Date.now() + 120_000));
    expect(laterEntries[0]?.attempts).toBe(4);
  });

  it('caps the backoff instead of growing without bound', () => {
    const store = createStore();
    store.enqueueOutboxEvent(eventFixture('evt_capped'));
    store.recordOutboxDeliveryAttempt('evt_capped', 99);
    expect(store.listDueOutboxEntries(25, new Date(Date.now() + 400_000))).toHaveLength(1);
  });

  it('survives a restart of the process', () => {
    const database = createLocalAgentDatabase(':memory:');
    const first = new LocalStore(database);
    first.enqueueOutboxEvent(eventFixture('evt_persisted'));
    const afterRestart = new LocalStore(database);
    expect(afterRestart.countPendingOutboxEntries()).toBe(1);
    expect(afterRestart.listDueOutboxEntries()[0]?.event.type).toBe('job.completed');
  });
});

describe('command idempotency', () => {
  it('returns nothing for an unseen key', () => {
    expect(createStore().findProcessedCommand('unknown')).toBeNull();
  });

  it('replays the recorded result for a duplicate command', () => {
    const store = createStore();
    store.recordProcessedCommand('idem_1', 'task.start', { jobId: 'job_1' });
    store.recordProcessedCommand('idem_1', 'task.start', { jobId: 'job_SHOULD_NOT_REPLACE' });
    expect(store.findProcessedCommand('idem_1')).toEqual({ jobId: 'job_1' });
  });
});

describe('domain sessions', () => {
  it('finds a reusable session for a project and provider', () => {
    const store = createStore();
    const timestamp = nowIsoTimestamp();
    store.saveDomainSession({
      id: 'dsn_1',
      userId: 'user_1',
      deviceId: 'dev_1',
      domain: 'coding',
      providerId: 'fake',
      projectPath: 'C:/projects/demo',
      title: 'demo',
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
    });
    expect(store.findReusableSessionForProject('C:/projects/demo', 'fake')?.id).toBe('dsn_1');
    expect(store.findReusableSessionForProject('C:/projects/demo', 'codex')).toBeNull();
    expect(store.findReusableSessionForProject('C:/projects/other', 'fake')).toBeNull();
  });

  it('ignores closed sessions when looking for one to reuse', () => {
    const store = createStore();
    const timestamp = nowIsoTimestamp();
    store.saveDomainSession({
      id: 'dsn_closed',
      userId: 'user_1',
      deviceId: 'dev_1',
      domain: 'coding',
      providerId: 'fake',
      projectPath: 'C:/projects/demo',
      title: 'demo',
      status: 'closed',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
    });
    expect(store.findReusableSessionForProject('C:/projects/demo')).toBeNull();
  });
});
