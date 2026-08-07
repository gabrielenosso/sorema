import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import {
  createIdentifier,
  nowIsoTimestamp,
  TERMINAL_JOB_STATUSES,
  type SoremaEvent,
  type DomainSession,
  type Job,
} from '@sorema/domain-model';
import type { LocalAgentDatabase } from '../db/client.js';
import {
  localAuditLogTable,
  localDomainSessionsTable,
  localJobsTable,
  outboxTable,
  processedCommandsTable,
} from '../db/schema.js';

export type LocalJob = Job & { instruction: string; providerId: string };

export type OutboxEntry = {
  eventId: string;
  event: SoremaEvent;
  attempts: number;
  nextAttemptAt: string;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function optional(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function toLocalJob(row: typeof localJobsTable.$inferSelect): LocalJob {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    conversationId: optional(row.conversationId),
    domainSessionId: optional(row.domainSessionId),
    domain: row.domain,
    type: row.type,
    status: row.status as Job['status'],
    progress: row.progress === null ? undefined : row.progress / 100,
    summary: optional(row.summary),
    error: row.errorJson ? parseJson<Job['error']>(row.errorJson, undefined) : undefined,
    createdAt: row.createdAt,
    startedAt: optional(row.startedAt),
    completedAt: optional(row.completedAt),
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    instruction: row.instruction,
    providerId: row.providerId,
  };
}

function toDomainSession(row: typeof localDomainSessionsTable.$inferSelect): DomainSession {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    domain: row.domain as DomainSession['domain'],
    providerId: row.providerId,
    providerSessionId: optional(row.providerSessionId),
    projectPath: optional(row.projectPath),
    title: row.title,
    status: row.status as DomainSession['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
  };
}

/**
 * Delay before the *next* attempt, indexed by how many attempts have already been made. The first
 * send happens immediately when the event is queued, so index 0 is a retry delay and must be
 * greater than zero: a zero here makes an unacknowledged event resend on every flush tick.
 */
const BACKOFF_SCHEDULE_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

export class LocalStore {
  private readonly database: LocalAgentDatabase;

  constructor(database: LocalAgentDatabase) {
    this.database = database;
  }

  saveJob(job: LocalJob): void {
    const values = {
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
    };
    this.database
      .insert(localJobsTable)
      .values(values)
      .onConflictDoUpdate({ target: localJobsTable.id, set: values })
      .run();
  }

  findJob(jobId: string): LocalJob | null {
    const row = this.database
      .select()
      .from(localJobsTable)
      .where(eq(localJobsTable.id, jobId))
      .get();
    return row ? toLocalJob(row) : null;
  }

  listJobs(options: { activeOnly?: boolean } = {}): LocalJob[] {
    const rows = options.activeOnly
      ? this.database
          .select()
          .from(localJobsTable)
          .where(inArray(localJobsTable.status, ['queued', 'running', 'waiting_for_approval']))
          .all()
      : this.database.select().from(localJobsTable).all();
    return rows.map(toLocalJob);
  }

  listUnfinishedJobs(): LocalJob[] {
    return this.listJobs().filter(
      (job) => !TERMINAL_JOB_STATUSES.includes(job.status) && job.status !== 'interrupted',
    );
  }

  saveDomainSession(session: DomainSession): void {
    const values = {
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
    };
    this.database
      .insert(localDomainSessionsTable)
      .values(values)
      .onConflictDoUpdate({ target: localDomainSessionsTable.id, set: values })
      .run();
  }

  findDomainSession(sessionId: string): DomainSession | null {
    const row = this.database
      .select()
      .from(localDomainSessionsTable)
      .where(eq(localDomainSessionsTable.id, sessionId))
      .get();
    return row ? toDomainSession(row) : null;
  }

  listDomainSessions(filter: { domain?: string; projectPath?: string } = {}): DomainSession[] {
    return this.database
      .select()
      .from(localDomainSessionsTable)
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

  enqueueOutboxEvent(event: SoremaEvent): void {
    const timestamp = nowIsoTimestamp();
    this.database
      .insert(outboxTable)
      .values({
        eventId: event.eventId,
        payloadJson: JSON.stringify(event),
        attempts: 0,
        nextAttemptAt: timestamp,
        createdAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
  }

  listDueOutboxEntries(limit = 25, now: Date = new Date()): OutboxEntry[] {
    return this.database
      .select()
      .from(outboxTable)
      .where(
        and(isNull(outboxTable.acknowledgedAt), lte(outboxTable.nextAttemptAt, now.toISOString())),
      )
      .orderBy(asc(outboxTable.createdAt))
      .limit(limit)
      .all()
      .map((row) => ({
        eventId: row.eventId,
        event: parseJson<SoremaEvent>(row.payloadJson, null as unknown as SoremaEvent),
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
      }))
      .filter((entry) => entry.event !== null);
  }

  countPendingOutboxEntries(): number {
    return this.database.select().from(outboxTable).where(isNull(outboxTable.acknowledgedAt)).all()
      .length;
  }

  acknowledgeOutboxEvent(eventId: string): void {
    this.database
      .update(outboxTable)
      .set({ acknowledgedAt: nowIsoTimestamp() })
      .where(eq(outboxTable.eventId, eventId))
      .run();
  }

  recordOutboxDeliveryAttempt(eventId: string, attempts: number): void {
    const delayMs =
      BACKOFF_SCHEDULE_MS[Math.min(attempts, BACKOFF_SCHEDULE_MS.length - 1)] ??
      BACKOFF_SCHEDULE_MS.at(-1) ??
      60_000;
    this.database
      .update(outboxTable)
      .set({
        attempts: attempts + 1,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      })
      .where(eq(outboxTable.eventId, eventId))
      .run();
  }

  findProcessedCommand(idempotencyKey: string): unknown | null {
    const row = this.database
      .select()
      .from(processedCommandsTable)
      .where(eq(processedCommandsTable.idempotencyKey, idempotencyKey))
      .get();
    return row ? parseJson<unknown>(row.resultJson, null) : null;
  }

  recordProcessedCommand(idempotencyKey: string, commandName: string, result: unknown): void {
    this.database
      .insert(processedCommandsTable)
      .values({
        idempotencyKey,
        commandName,
        resultJson: JSON.stringify(result),
        processedAt: nowIsoTimestamp(),
      })
      .onConflictDoNothing()
      .run();
  }

  appendAuditEntry(entry: {
    action: string;
    outcome: string;
    correlationId?: string;
    details?: Record<string, unknown>;
  }): void {
    this.database
      .insert(localAuditLogTable)
      .values({
        id: createIdentifier('audit'),
        action: entry.action,
        outcome: entry.outcome,
        correlationId: entry.correlationId ?? null,
        detailsJson: JSON.stringify(entry.details ?? {}),
        createdAt: nowIsoTimestamp(),
      })
      .run();
  }
}
