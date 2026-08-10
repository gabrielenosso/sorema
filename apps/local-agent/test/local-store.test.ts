import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nowIsoTimestamp } from '@sorema/domain-model';
import { createLocalAgentDatabase, type LocalAgentDatabase } from '../src/db/client.js';
import { LocalStore, type LocalJob } from '../src/store/local-store.js';

/**
 * A database file written by the build before this one, by better-sqlite3 through drizzle.
 *
 * It is committed rather than generated, because the only version of this proof that means anything
 * is bytes the old dependency really produced: generating it here would need the dependency this
 * change exists to remove, and rebuilding it with the new code would be the new code agreeing with
 * itself. SQLite's file format is the same either side of the swap, which is the claim.
 */
const LEGACY_DATABASE = join(import.meta.dirname, 'fixtures', 'legacy-better-sqlite3.sqlite');

function openCopyOfLegacyDatabase(): {
  store: LocalStore;
  database: LocalAgentDatabase;
  path: string;
} {
  // Copied, because opening it runs the migrations, which drop `audit_log` and would rewrite the
  // fixture in the working tree the first time this ran.
  const path = join(mkdtempSync(join(tmpdir(), 'sorema-legacy-')), 'sorema.sqlite');
  copyFileSync(LEGACY_DATABASE, path);
  const database = createLocalAgentDatabase(`file:${path}`);
  return { store: new LocalStore(database), database, path };
}

function tableNames(database: LocalAgentDatabase): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row['name']))
    .sort();
}

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

/**
 * The upgrade path, which is that there is not one.
 *
 * Both builds write plain SQLite, so the file a user already has is the file this one opens. If that
 * were ever untrue the symptom would be a machine that comes back from an update with no history:
 * the jobs it ran and the coding sessions it can resume both gone, silently, because a fresh
 * database is indistinguishable from an empty one.
 */
describe('a database written by the better-sqlite3 build', () => {
  it('is read by node:sqlite with the job history intact', () => {
    const { store } = openCopyOfLegacyDatabase();

    const running = store.findJob('job_legacy_running');
    expect(running).toMatchObject({
      status: 'running',
      userId: 'user_legacy',
      deviceId: 'dev_legacy',
      conversationId: 'conv_legacy',
      domainSessionId: 'dsn_legacy',
      instruction: 'rename the thing',
      providerId: 'codex',
      idempotencyKey: 'idem_legacy',
      correlationId: 'corr_legacy',
      createdAt: '2026-01-02T03:04:05.000Z',
      startedAt: '2026-01-02T03:04:06.000Z',
    });
    // Stored as hundredths by the old build and read back as a fraction by this one. A rounding
    // change here would be invisible in every other assertion.
    expect(running?.progress).toBeCloseTo(0.42, 2);

    const failed = store.findJob('job_legacy_failed');
    expect(failed?.summary).toBe('it did not work');
    expect(failed?.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'the provider died' });
    expect(store.listJobs()).toHaveLength(2);
  });

  it('keeps the coding session that build left behind, so it can still be resumed', () => {
    const { store } = openCopyOfLegacyDatabase();

    const session = store.findReusableSessionForProject('C:/projects/legacy', 'codex');
    expect(session).toMatchObject({
      id: 'dsn_legacy',
      providerSessionId: 'provider-session-legacy',
      title: 'legacy session',
      status: 'idle',
    });
    // The provider's own handle on the conversation. Lose this and the machine can still list the
    // session and can never continue it.
    expect(session?.metadata).toEqual({ rolloutPath: 'C:/rollouts/legacy.jsonl' });
  });

  it('goes on writing to the same file, rather than starting a new one beside it', () => {
    const { store, path } = openCopyOfLegacyDatabase();
    store.saveJob(jobFixture({ id: 'job_after_upgrade' }));

    const reopened = new LocalStore(createLocalAgentDatabase(`file:${path}`));
    expect(
      reopened
        .listJobs()
        .map((job) => job.id)
        .sort(),
    ).toEqual(['job_after_upgrade', 'job_legacy_failed', 'job_legacy_running']);
  });

  it('takes the audit log with it, having decided nobody was ever going to read it', () => {
    // The fixture carries an `audit_log` table with a row in it, written by the build that had two
    // writers for it and no readers anywhere. What is asserted is that it is gone from a machine
    // that already had one, not merely absent from a fresh install: abandoning it would have left
    // the unbounded growth in place for exactly the people who ran the old command longest.
    const { database } = openCopyOfLegacyDatabase();

    expect(tableNames(database)).toEqual(['domain_sessions', 'jobs']);
  });
});

/**
 * The tables the gateway era left behind, and that 0.9.0 shipped again.
 *
 * The legacy fixture predates them, so nothing else in this file can see whether they are dropped —
 * and a `DROP TABLE` nobody exercises is a line that looks like a migration and is not one. This
 * builds the table by hand, on the same database shape, and watches it go.
 */
describe('the tables no code reads any more', () => {
  it('drops outbox and processed_commands from a database that has them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sorema-legacy-tables-'));
    const path = join(directory, 'sorema.sqlite');

    // Fetched late, the same way the store does: a static import of node:sqlite is linked before
    // any statement runs, which is what would kill the version check on an older Node.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const before = new DatabaseSync(path);
    before.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    before.exec('CREATE TABLE processed_commands (id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)');
    before.exec("INSERT INTO outbox VALUES ('one', '{}')");
    before.close();

    const database = createLocalAgentDatabase(`file:${path}`);
    try {
      expect(tableNames(database)).not.toContain('outbox');
      expect(tableNames(database)).not.toContain('processed_commands');
      // And the tables that carry real history are untouched by the same migration run.
      expect(tableNames(database)).toEqual(['domain_sessions', 'jobs']);
    } finally {
      database.close();
    }
  });
});
