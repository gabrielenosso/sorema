import type { SQLOutputValue } from 'node:sqlite';
import { TERMINAL_JOB_STATUSES, type DomainSession, type Job } from '@sorema/domain-model';
import type { LocalAgentDatabase } from '../db/client.js';

export type LocalJob = Job & { instruction: string; providerId: string };

type Row = Record<string, SQLOutputValue>;

const ACTIVE_JOB_STATUSES: readonly string[] = ['queued', 'running', 'waiting_for_approval'];

// Built from the list rather than written beside it, so adding a status cannot leave the query
// binding fewer values than it was given.
const ACTIVE_JOB_PLACEHOLDERS = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');

/**
 * A whole row every time, which is why `INSERT OR REPLACE` is the same thing the query builder's
 * upsert used to do here: every column is supplied, the conflict can only be the primary key, and
 * there are no foreign keys or triggers for the delete half of a replace to reach.
 */
const SAVE_JOB = `INSERT OR REPLACE INTO jobs (
    id, user_id, device_id, conversation_id, domain_session_id, domain, type, status, progress,
    summary, error_json, instruction, provider_id, created_at, started_at, completed_at,
    idempotency_key, correlation_id
  ) VALUES (
    :id, :userId, :deviceId, :conversationId, :domainSessionId, :domain, :type, :status, :progress,
    :summary, :errorJson, :instruction, :providerId, :createdAt, :startedAt, :completedAt,
    :idempotencyKey, :correlationId
  )`;

const SAVE_DOMAIN_SESSION = `INSERT OR REPLACE INTO domain_sessions (
    id, user_id, device_id, domain, provider_id, provider_session_id, project_path, title, status,
    metadata_json, created_at, updated_at
  ) VALUES (
    :id, :userId, :deviceId, :domain, :providerId, :providerSessionId, :projectPath, :title,
    :status, :metadataJson, :createdAt, :updatedAt
  )`;

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readText(row: Row, column: string): string {
  const value = row[column];
  // Every column read through here is NOT NULL in the schema, so anything else is a row this build
  // did not write and cannot honestly interpret.
  if (typeof value !== 'string') throw new Error(`Column ${column} does not hold text`);
  return value;
}

function readOptionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalInteger(row: Row, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' ? value : undefined;
}

function toLocalJob(row: Row): LocalJob {
  const progress = readOptionalInteger(row, 'progress');
  return {
    id: readText(row, 'id'),
    userId: readText(row, 'user_id'),
    deviceId: readText(row, 'device_id'),
    conversationId: readOptionalText(row, 'conversation_id'),
    domainSessionId: readOptionalText(row, 'domain_session_id'),
    domain: readText(row, 'domain'),
    type: readText(row, 'type'),
    status: readText(row, 'status') as Job['status'],
    progress: progress === undefined ? undefined : progress / 100,
    summary: readOptionalText(row, 'summary'),
    error: parseJson<Job['error']>(readOptionalText(row, 'error_json'), undefined),
    createdAt: readText(row, 'created_at'),
    startedAt: readOptionalText(row, 'started_at'),
    completedAt: readOptionalText(row, 'completed_at'),
    idempotencyKey: readText(row, 'idempotency_key'),
    correlationId: readText(row, 'correlation_id'),
    instruction: readText(row, 'instruction'),
    providerId: readText(row, 'provider_id'),
  };
}

function toDomainSession(row: Row): DomainSession {
  return {
    id: readText(row, 'id'),
    userId: readText(row, 'user_id'),
    deviceId: readText(row, 'device_id'),
    domain: readText(row, 'domain') as DomainSession['domain'],
    providerId: readText(row, 'provider_id'),
    providerSessionId: readOptionalText(row, 'provider_session_id'),
    projectPath: readOptionalText(row, 'project_path'),
    title: readText(row, 'title'),
    status: readText(row, 'status') as DomainSession['status'],
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
    metadata: parseJson<Record<string, unknown>>(readOptionalText(row, 'metadata_json'), {}),
  };
}

export class LocalStore {
  private readonly database: LocalAgentDatabase;

  constructor(database: LocalAgentDatabase) {
    this.database = database;
  }

  saveJob(job: LocalJob): void {
    this.database.prepare(SAVE_JOB).run({
      id: job.id,
      userId: job.userId,
      deviceId: job.deviceId,
      conversationId: job.conversationId ?? null,
      domainSessionId: job.domainSessionId ?? null,
      domain: job.domain,
      type: job.type,
      status: job.status,
      progress: job.progress === undefined ? null : Math.round(job.progress * 100),
      summary: job.summary ?? null,
      errorJson: job.error ? JSON.stringify(job.error) : null,
      instruction: job.instruction,
      providerId: job.providerId,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
      idempotencyKey: job.idempotencyKey,
      correlationId: job.correlationId,
    });
  }

  findJob(jobId: string): LocalJob | null {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    return row ? toLocalJob(row) : null;
  }

  listJobs(options: { activeOnly?: boolean } = {}): LocalJob[] {
    const rows = options.activeOnly
      ? this.database
          .prepare(`SELECT * FROM jobs WHERE status IN (${ACTIVE_JOB_PLACEHOLDERS})`)
          .all(...ACTIVE_JOB_STATUSES)
      : this.database.prepare('SELECT * FROM jobs').all();
    return rows.map(toLocalJob);
  }

  listUnfinishedJobs(): LocalJob[] {
    return this.listJobs().filter(
      (job) => !TERMINAL_JOB_STATUSES.includes(job.status) && job.status !== 'interrupted',
    );
  }

  saveDomainSession(session: DomainSession): void {
    this.database.prepare(SAVE_DOMAIN_SESSION).run({
      id: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      domain: session.domain,
      providerId: session.providerId,
      providerSessionId: session.providerSessionId ?? null,
      projectPath: session.projectPath ?? null,
      title: session.title,
      status: session.status,
      metadataJson: JSON.stringify(session.metadata),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  findDomainSession(sessionId: string): DomainSession | null {
    const row = this.database.prepare('SELECT * FROM domain_sessions WHERE id = ?').get(sessionId);
    return row ? toDomainSession(row) : null;
  }

  listDomainSessions(filter: { domain?: string; projectPath?: string } = {}): DomainSession[] {
    return this.database
      .prepare('SELECT * FROM domain_sessions')
      .all()
      .map(toDomainSession)
      .filter((session) => !filter.domain || session.domain === filter.domain)
      .filter((session) => !filter.projectPath || session.projectPath === filter.projectPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  findReusableSessionForProject(projectPath: string, providerId?: string): DomainSession | null {
    return (
      this.listDomainSessions({ domain: 'coding', projectPath }).find(
        (session) =>
          (session.status === 'active' || session.status === 'idle') &&
          (!providerId || session.providerId === providerId),
      ) ?? null
    );
  }
}
