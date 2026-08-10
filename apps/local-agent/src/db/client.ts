import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveSqliteFilePath } from '@sorema/config';
import { LOCAL_AGENT_MIGRATION_STATEMENTS } from './schema.js';
import { loadDatabaseSyncConstructor } from './sqlite-runtime.js';

export type LocalAgentDatabase = DatabaseSync;

export function createLocalAgentDatabase(databaseUrl: string): LocalAgentDatabase {
  const isMemory = databaseUrl === ':memory:' || databaseUrl === 'file::memory:';
  const filePath = isMemory ? ':memory:' : resolveSqliteFilePath(databaseUrl);
  if (!isMemory) mkdirSync(dirname(filePath), { recursive: true });

  const Database = loadDatabaseSyncConstructor();
  const connection = new Database(filePath);
  // The file this opens is the one the previous build wrote: same SQLite, same format, so there is
  // nothing to migrate and a user's job history and coding sessions carry over untouched. WAL stays
  // for the reason it was set in the first place — the agent writes while its own HTTP handlers
  // read, and the default rollback journal blocks one on the other.
  connection.exec('PRAGMA journal_mode = WAL');
  for (const statement of LOCAL_AGENT_MIGRATION_STATEMENTS) connection.exec(statement);

  return connection;
}
