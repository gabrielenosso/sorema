import type { SQLOutputValue } from 'node:sqlite';
import { TERMINAL_JOB_STATUSES, type DomainSession, type Job } from '@sorema/domain-model';
import type { LocalAgentDatabase } from '../db/client.js';

export type LocalJob = Job & { instruction: string; providerId: string };

type Row = Record<string, SQLOutputValue>;

const ACTIVE_JOB_STATUSES: readonly string[] = ['queued', 'running', 'waiting_for_approval'];

/**
 * How long a job may go unheard from before it stops holding its project shut.
 *
 * The working-tree lock refuses a second agent while one is running, which is right: two agents
 * editing the same files is how somebody loses work. But a job whose provider died without ever
 * emitting a terminal event stays `running`, and then every later attempt on that project is refused
 * for ever — from a voice conversation with no way out at all. A restart clears them; a machine left
 * on for a week does not restart.
 *
 * Measured from when the job began, because a job row carries no heartbeat: it has `created_at`,
 * `started_at` and `completed_at`, and a running job touches none of them. Twice the provider's own
 * fifteen-minute timeout, so a slow job that is genuinely working is never mistaken for a dead one —
 * anything alive at that point has missed its own deadline by the same margin again.
 */
const STALE_ACTIVE_JOB_MS = 2 * 15 * 60 * 1_000;

// Built from the list rather than written beside it, so adding a status cannot leave the query
// binding fewer values than it was given.
const ACTIVE_JOB_PLACEHOLDERS = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');
const SESSION_ACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * A whole row every time, which is why `INSERT OR REPLACE` is the same thing the query builder's
 * upsert used to do here: every column is supplied, the conflict can only be the primary key, and
 * there are no foreign keys or triggers for the delete half of a replace to reach.
 */
const SAVE_JOB = `INSERT INTO jobs (
    id, user_id, device_id, conversation_id, domain_session_id, domain, type, status, progress,
    summary, error_json, instruction, provider_id, created_at, started_at, completed_at,
    idempotency_key, correlation_id
  ) VALUES (
    :id, :userId, :deviceId, :conversationId, :domainSessionId, :domain, :type, :status, :progress,
    :summary, :errorJson, :instruction, :providerId, :createdAt, :startedAt, :completedAt,
    :idempotencyKey, :correlationId
  ) ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    device_id = excluded.device_id,
    conversation_id = excluded.conversation_id,
    domain_session_id = excluded.domain_session_id,
    domain = excluded.domain,
    type = excluded.type,
    status = excluded.status,
    progress = excluded.progress,
    summary = excluded.summary,
    error_json = excluded.error_json,
    instruction = excluded.instruction,
    provider_id = excluded.provider_id,
    created_at = excluded.created_at,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    idempotency_key = excluded.idempotency_key,
    correlation_id = excluded.correlation_id`;

const SAVE_DOMAIN_SESSION = `INSERT INTO domain_sessions (
    id, user_id, device_id, domain, provider_id, provider_session_id, project_path, title, status,
    metadata_json, created_at, updated_at
  ) VALUES (
    :id, :userId, :deviceId, :domain, :providerId, :providerSessionId, :projectPath, :title,
    :status, :metadataJson, :createdAt, :updatedAt
  ) ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    device_id = excluded.device_id,
    domain = excluded.domain,
    provider_id = excluded.provider_id,
    provider_session_id = excluded.provider_session_id,
    project_path = excluded.project_path,
    title = excluded.title,
    status = excluded.status,
    metadata_json = excluded.metadata_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`;

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
    archivedAt: readOptionalText(row, 'archived_at'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
    metadata: parseJson<Record<string, unknown>>(readOptionalText(row, 'metadata_json'), {}),
  };
}

export class LocalStore {
  private readonly database: LocalAgentDatabase;

  constructor(database: LocalAgentDatabase) {
    this.database = database;
    this.database
      .prepare('DELETE FROM session_action_results WHERE created_at < ?')
      .run(new Date(Date.now() - SESSION_ACTION_RETENTION_MS).toISOString());
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

  saveCloudEvent(eventId: string, payload: Record<string, unknown>): void {
    this.database
      .prepare(
        `INSERT INTO cloud_event_outbox (event_id, payload_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(eventId, JSON.stringify(payload), new Date().toISOString());
  }

  listCloudEvents(): Record<string, unknown>[] {
    return this.database
      .prepare('SELECT payload_json FROM cloud_event_outbox ORDER BY created_at, event_id')
      .all()
      .map((row) =>
        parseJson<Record<string, unknown> | null>(readOptionalText(row, 'payload_json'), null),
      )
      .filter((payload): payload is Record<string, unknown> => payload !== null);
  }

  deleteCloudEvent(eventId: string): void {
    this.database.prepare('DELETE FROM cloud_event_outbox WHERE event_id = ?').run(eventId);
  }

  findJob(jobId: string): LocalJob | null {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    return row ? toLocalJob(row) : null;
  }

  findJobByIdempotencyKey(idempotencyKey: string): LocalJob | null {
    const row = this.database
      .prepare('SELECT * FROM jobs WHERE idempotency_key = ? LIMIT 1')
      .get(idempotencyKey);
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
    const row = this.database
      .prepare(
        `SELECT domain_sessions.*, archived_domain_sessions.archived_at
         FROM domain_sessions
         LEFT JOIN archived_domain_sessions ON archived_domain_sessions.session_id = domain_sessions.id
         WHERE domain_sessions.id = ?`,
      )
      .get(sessionId);
    return row ? toDomainSession(row) : null;
  }

  listDomainSessions(
    filter: {
      domain?: string;
      projectPath?: string;
      includeArchived?: boolean;
      userId?: string;
      deviceId?: string;
    } = {},
  ): DomainSession[] {
    return this.database
      .prepare(
        `SELECT domain_sessions.*, archived_domain_sessions.archived_at
         FROM domain_sessions
         LEFT JOIN archived_domain_sessions ON archived_domain_sessions.session_id = domain_sessions.id`,
      )
      .all()
      .map(toDomainSession)
      .filter((session) => !filter.domain || session.domain === filter.domain)
      .filter((session) => !filter.projectPath || session.projectPath === filter.projectPath)
      .filter((session) => !filter.userId || session.userId === filter.userId)
      .filter((session) => !filter.deviceId || session.deviceId === filter.deviceId)
      .filter((session) => filter.includeArchived || !session.archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  setDomainSessionArchived(sessionId: string, archivedAt: string | null): DomainSession | null {
    if (!this.findDomainSession(sessionId)) return null;
    if (archivedAt) {
      this.database
        .prepare(
          `INSERT INTO archived_domain_sessions (session_id, archived_at) VALUES (?, ?)
           ON CONFLICT(session_id) DO UPDATE SET archived_at = excluded.archived_at`,
        )
        .run(sessionId, archivedAt);
    } else {
      this.database
        .prepare('DELETE FROM archived_domain_sessions WHERE session_id = ?')
        .run(sessionId);
    }
    return this.findDomainSession(sessionId);
  }

  findActiveJobForSession(sessionId: string): LocalJob | null {
    const row = this.database
      .prepare(
        `SELECT * FROM jobs
         WHERE domain_session_id = ? AND status IN (${ACTIVE_JOB_PLACEHOLDERS})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, ...ACTIVE_JOB_STATUSES);
    return row ? toLocalJob(row) : null;
  }

  findSessionActionResult(idempotencyKey: string): unknown | null {
    const row = this.database
      .prepare('SELECT result_json FROM session_action_results WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? parseJson(String(row['result_json']), null) : null;
  }

  saveSessionActionResult(idempotencyKey: string, result: unknown): void {
    this.database
      .prepare(
        `INSERT INTO session_action_results (idempotency_key, result_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(idempotencyKey, JSON.stringify(result), new Date().toISOString());
  }

  findActiveJobForProject(projectPath: string, userId: string, deviceId: string): LocalJob | null {
    const row = this.database
      .prepare(
        `SELECT jobs.* FROM jobs
         INNER JOIN domain_sessions ON domain_sessions.id = jobs.domain_session_id
         WHERE domain_sessions.project_path = ?
           AND domain_sessions.user_id = ?
           AND domain_sessions.device_id = ?
           AND jobs.status IN (${ACTIVE_JOB_PLACEHOLDERS})
           AND COALESCE(jobs.started_at, jobs.created_at) >= ?
         ORDER BY jobs.created_at DESC LIMIT 1`,
      )
      .get(
        projectPath,
        userId,
        deviceId,
        ...ACTIVE_JOB_STATUSES,
        new Date(Date.now() - STALE_ACTIVE_JOB_MS).toISOString(),
      );
    return row ? toLocalJob(row) : null;
  }

  findReusableSessionForProject(
    projectPath: string,
    providerId?: string,
    owner?: { userId: string; deviceId: string },
  ): DomainSession | null {
    return (
      this.listDomainSessions({ domain: 'coding', projectPath, ...owner }).find(
        (session) =>
          (session.status === 'active' || session.status === 'idle') &&
          !session.archivedAt &&
          (!providerId || session.providerId === providerId),
      ) ?? null
    );
  }
}
