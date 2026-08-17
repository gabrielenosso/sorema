/**
 * The whole of this machine's storage, as the statements that build it.
 *
 * There is no query builder behind these any more: `node:sqlite` is in the runtime, the store is a
 * hundred lines of SQL, and a dependency that has to be compiled for every platform we publish to
 * was buying nothing but the `eq` in a where clause. `IF NOT EXISTS` throughout, because the file
 * an upgrade opens is the file the previous build wrote.
 */
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
  `UPDATE jobs
   SET idempotency_key = idempotency_key || ':legacy:' || id
   WHERE id NOT IN (SELECT MIN(id) FROM jobs GROUP BY idempotency_key)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_unique ON jobs(idempotency_key)',
  `CREATE TABLE IF NOT EXISTS archived_domain_sessions (
    session_id TEXT PRIMARY KEY,
    archived_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES domain_sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS session_action_results (
    idempotency_key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // `audit_log` is gone rather than capped, and this statement is here so it goes from the machines
  // that already have it as well as from the ones that do not.
  //
  // Two call sites wrote it — creating a project and starting a coding task — and nothing in this
  // repository, the cloud or the command ever read a row back. It had no eviction either, so on a
  // machine somebody actually uses it grew for the life of the install. Giving it a reader was the
  // alternative and it earns nothing: every field it held is already in a row that is kept and read
  // aloud. The job carries its own instruction, provider, project, correlation id and timestamps,
  // and a created project is a folder on disk that `projects.list` reports. An audit log that
  // duplicates the records people actually consult is not a second opinion, it is a second copy.
  //
  // Dropping rather than merely abandoning it, because rows no code can reach are not a trail: they
  // are disk, and leaving them punishes exactly the users who ran the old build longest.
  'DROP TABLE IF EXISTS audit_log',
  // Left behind by the gateway era and by 0.9.0, which shipped from a checkout that still had them.
  // Nothing reads either one now, so on disk they are only somebody's job history and command
  // history sitting where no code will ever look at it again.
  'DROP TABLE IF EXISTS outbox',
  'DROP TABLE IF EXISTS processed_commands',
  // Left behind by the gateway era and by 0.9.0, which shipped from a checkout that still had them.
  // Nothing reads either one now, so on disk they are only somebody's job history and command
  // history sitting where no code will ever look at it again.
  // Left behind by the gateway era and by 0.9.0, which shipped from a checkout that still had them.
  // Nothing reads either one now, so on disk they are only somebody's job history and command
  // history sitting where no code will ever look at it again.
];
