import type { DatabaseSync } from 'node:sqlite';

export type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

/**
 * The first minor of each Node line that offers `node:sqlite` without a command line flag.
 *
 * 22.5 built SQLite into the runtime and 22.13 stopped hiding it behind `--experimental-sqlite`;
 * the odd numbered line did the same at 23.4. Anything older cannot resolve the module at all, and
 * says so while the program is still being linked: `No such built-in module: node:sqlite`, thrown
 * before a line of ours has run, which reads like a broken install rather than like an old Node.
 */
const FIRST_UNFLAGGED_MINOR_BY_MAJOR = new Map<number, number>([
  [22, 13],
  [23, 4],
]);

const OLDEST_SUPPORTED_MAJOR = 22;

export function nodeVersionHasBuiltInSqlite(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (major === undefined || !Number.isInteger(major)) return false;
  if (major < OLDEST_SUPPORTED_MAJOR) return false;
  const firstUnflaggedMinor = FIRST_UNFLAGGED_MINOR_BY_MAJOR.get(major);
  if (firstUnflaggedMinor === undefined) return true;
  return (minor ?? 0) >= firstUnflaggedMinor;
}

export function describeUnsupportedNodeVersion(version: string): string {
  return (
    'Sorema keeps its job history in SQLite, which Node only offers from version 22.13 ' +
    `(or 23.4, on the odd numbered line). This machine is running Node ${version}.\n` +
    'Install the current LTS from https://nodejs.org and run this again.'
  );
}

function isNodeSqliteModule(value: unknown): value is { DatabaseSync: DatabaseSyncConstructor } {
  if (typeof value !== 'object' || value === null) return false;
  return 'DatabaseSync' in value && typeof value.DatabaseSync === 'function';
}

/**
 * Reaches `node:sqlite` late, on purpose.
 *
 * A static import is linked before any statement in this file runs, so on an old Node the process
 * would die with the module resolver's message and the sentence above would never be printed. It
 * would also die at load rather than at first use, which is the shape of failure this repository
 * has shipped three times. `engines` cannot express the hole between 23.0 and 23.3 either, so the
 * manifest alone was never going to be enough.
 */
export function loadDatabaseSyncConstructor(
  nodeVersion: string = process.versions.node,
): DatabaseSyncConstructor {
  if (!nodeVersionHasBuiltInSqlite(nodeVersion)) {
    throw new Error(describeUnsupportedNodeVersion(nodeVersion));
  }
  const builtin: unknown = process.getBuiltinModule('node:sqlite');
  if (!isNodeSqliteModule(builtin)) throw new Error(describeUnsupportedNodeVersion(nodeVersion));
  return builtin.DatabaseSync;
}
