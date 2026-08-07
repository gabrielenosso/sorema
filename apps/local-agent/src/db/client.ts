import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolveSqliteFilePath } from '@sorema/config';
import { LOCAL_AGENT_MIGRATION_STATEMENTS } from './schema.js';

export type LocalAgentDatabase = BetterSQLite3Database<Record<string, never>> & {
  $client: Database.Database;
};

export function createLocalAgentDatabase(databaseUrl: string): LocalAgentDatabase {
  const isMemory = databaseUrl === ':memory:' || databaseUrl === 'file::memory:';
  const filePath = isMemory ? ':memory:' : resolveSqliteFilePath(databaseUrl);
  if (!isMemory) mkdirSync(dirname(filePath), { recursive: true });

  const connection = new Database(filePath);
  connection.pragma('journal_mode = WAL');
  for (const statement of LOCAL_AGENT_MIGRATION_STATEMENTS) connection.exec(statement);

  return drizzle(connection) as LocalAgentDatabase;
}
