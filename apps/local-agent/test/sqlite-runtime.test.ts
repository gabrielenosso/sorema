import { describe, expect, it } from 'vitest';
import {
  describeUnsupportedNodeVersion,
  loadDatabaseSyncConstructor,
  nodeVersionHasBuiltInSqlite,
} from '../src/db/sqlite-runtime.js';

/**
 * Which Node versions can run this at all.
 *
 * `node:sqlite` arrived in 22.5 behind `--experimental-sqlite` and was unflagged in 22.13, and in
 * 23.4 on the odd numbered line. `engines: ">=22.13.0"` cannot say that: it admits 23.0, where the
 * module exists and cannot be reached. So the version rule lives in the program, and this is it.
 */
describe('the Node versions that carry a usable node:sqlite', () => {
  it.each([
    ['20.19.0', false],
    ['22.0.0', false],
    ['22.4.1', false],
    // Built in from here, but only with the flag, so it is no use to a published command that has
    // no say in how it is launched.
    ['22.5.0', false],
    ['22.12.0', false],
    ['22.13.0', true],
    ['22.22.1', true],
    // The hole `engines` cannot express.
    ['23.0.0', false],
    ['23.3.0', false],
    ['23.4.0', true],
    ['24.0.0', true],
    ['26.7.0', true],
  ])('answers %s with %s', (version, supported) => {
    expect(nodeVersionHasBuiltInSqlite(version)).toBe(supported);
  });

  it('accepts the version string with or without its leading v', () => {
    expect(nodeVersionHasBuiltInSqlite('v22.13.0')).toBe(true);
    expect(nodeVersionHasBuiltInSqlite('v22.12.0')).toBe(false);
  });

  it('refuses anything it cannot read a major version out of', () => {
    expect(nodeVersionHasBuiltInSqlite('')).toBe(false);
    expect(nodeVersionHasBuiltInSqlite('unknown')).toBe(false);
  });

  it('is the version this test runner is on, or the rest of the suite proves nothing', () => {
    expect(nodeVersionHasBuiltInSqlite(process.versions.node)).toBe(true);
  });
});

describe('what an old Node is told', () => {
  /**
   * The whole point of the check. Without it the process dies while it is still being linked, with
   * `No such built-in module: node:sqlite` and nothing else — which reads like a corrupt install,
   * and is the same fatal-at-first-touch shape that shipped through six releases here already.
   */
  it('names the version needed, the version found, and what to do about it', () => {
    const said = describeUnsupportedNodeVersion('22.12.0');

    expect(said).toContain('22.13');
    expect(said).toContain('22.12.0');
    expect(said).toContain('https://nodejs.org');
    expect(said).not.toMatch(/built-in module|ERR_UNKNOWN/);
  });

  it('refuses to hand back a constructor on a version that cannot have one', () => {
    expect(() => loadDatabaseSyncConstructor('22.12.0')).toThrow(/22\.13/);
  });

  it('hands back a working one on this version', () => {
    const Database = loadDatabaseSyncConstructor();
    const connection = new Database(':memory:');
    connection.exec('CREATE TABLE probe (value TEXT)');
    connection.prepare('INSERT INTO probe VALUES (?)').run('present');
    expect(connection.prepare('SELECT value FROM probe').get()).toMatchObject({
      value: 'present',
    });
    connection.close();
  });
});
