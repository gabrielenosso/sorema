import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const localJobsTable = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  conversationId: text('conversation_id'),
  domainSessionId: text('domain_session_id'),
  domain: text('domain').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  progress: integer('progress'),
  summary: text('summary'),
  errorJson: text('error_json'),
  instruction: text('instruction').notNull().default(''),
  providerId: text('provider_id').notNull().default(''),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  idempotencyKey: text('idempotency_key').notNull(),
  correlationId: text('correlation_id').notNull(),
});

export const localDomainSessionsTable = sqliteTable('domain_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  domain: text('domain').notNull(),
  providerId: text('provider_id').notNull(),
  providerSessionId: text('provider_session_id'),
  projectPath: text('project_path'),
  title: text('title').notNull(),
  status: text('status').notNull(),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const outboxTable = sqliteTable('outbox', {
  eventId: text('event_id').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  acknowledgedAt: text('acknowledged_at'),
  createdAt: text('created_at').notNull(),
});

export const processedCommandsTable = sqliteTable('processed_commands', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  commandName: text('command_name').notNull(),
  resultJson: text('result_json').notNull(),
  processedAt: text('processed_at').notNull(),
});

export const localAuditLogTable = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  correlationId: text('correlation_id'),
  detailsJson: text('details_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

export const LOCAL_AGENT_MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    conversation_id TEXT,
    domain_session_id TEXT,
    domain TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER,
    summary TEXT,
    error_json TEXT,
    instruction TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    idempotency_key TEXT NOT NULL,
    correlation_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS domain_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_session_id TEXT,
    project_path TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS processed_commands (
    idempotency_key TEXT PRIMARY KEY,
    command_name TEXT NOT NULL,
    result_json TEXT NOT NULL,
    processed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    correlation_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
];
