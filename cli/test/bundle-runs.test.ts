import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(import.meta.dirname, '..', 'dist', 'sorema.mjs');

/**
 * Runs the published command the way a user's machine does.
 *
 * Every one of these failures shipped, and none of them could be seen from inside vitest: importing
 * the bundle here gets vite's CommonJS interop, which Node does not provide, so a bundle that dies
 * at load in production loads perfectly in a test. It has to be a separate `node` process running
 * the actual built file.
 *
 * What it caught: `Dynamic require of "fs" is not supported`, from a CommonJS dependency in an ESM
 * bundle — and only on `start`, because that is where the agent's storage layer is first touched.
 * Then a logger transport resolved by module path, which a single file cannot satisfy. Six versions
 * were published before anyone ran the built artifact from outside.
 */
/**
 * Makes the machine look paired, so the agent gets past its own front door.
 *
 * Without this, every command answers "not paired" and returns before a single one of the modules
 * that have actually been breaking is ever touched — which is why these tests passed through six
 * broken releases. The keys are real ones the command generated; only the account is invented.
 */
function pretendPaired(state: string): void {
  const file = join(state, 'device-identity.json');
  const identity = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...identity, deviceId: 'device-test', userId: 'user-test' }));
}

function run(
  args: readonly string[],
  timeoutMs = 20_000,
  extra: Record<string, string> = {},
  state = mkdtempSync(join(tmpdir(), 'sorema-bundle-')),
) {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Deleted, not defaulted: vitest sets NODE_ENV=test, so every child died at logger creation —
      // and the dying logger held the exit flush open for ten seconds, which the survival assertion
      // below then read as a healthy agent. These tests were passing on a corpse.
      NODE_ENV: undefined,
      // The bundle reads the home directory for some answers, so without this a developer's own
      // paired machine decides whether the test agrees with itself.
      USERPROFILE: state,
      HOME: state,
      SOREMA_API_URL: 'https://example.invalid',
      SOREMA_TUNNEL_URL: 'wss://example.invalid',
      LOCAL_AGENT_STATE_DIR: state,
      LOCAL_AGENT_DATABASE_URL: `file:${join(state, 'sorema.sqlite')}`,
      ...extra,
    },
  });
}

describe.skipIf(!existsSync(BUNDLE))('the built command runs outside this test runner', () => {
  it('prints its usage without dying at load', () => {
    const result = run(['help']);

    expect(result.stderr).not.toMatch(/Dynamic require/);
    expect(result.stdout).toContain('sorema');
    expect(result.status).toBe(0);
  });

  it.each(['status', 'help'])('answers %s without an unhandled failure', (command) => {
    const result = run([command]);

    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /Dynamic require|Cannot find|SyntaxError/,
    );
  });

  it('reaches the agent without a module it cannot resolve', () => {
    // `start` stays running, so it is killed by the timeout rather than exiting. What matters is
    // what it said before that: any of these means the bundle is broken for every user.
    const state = mkdtempSync(join(tmpdir(), 'sorema-bundle-'));
    run(['status'], 20_000, {}, state);
    pretendPaired(state);
    const startedAt = Date.now();
    const result = run(['start'], 12_000, {}, state);
    const ranForMs = Date.now() - startedAt;
    const said = `${result.stdout}${result.stderr}`;

    expect(said).not.toMatch(/Dynamic require/);
    expect(said).not.toMatch(/unable to determine transport target/);
    expect(said).not.toMatch(/Cannot find (module|package)/);
    // Positive evidence, not survival. A crashing logger can hold the exit open for ten seconds, so
    // "it was still running" is satisfied by a corpse; only a line the agent prints after opening
    // its own socket proves it got past every module it needs to reach.
    expect(said).toMatch(/listening/);
    expect(ranForMs).toBeGreaterThan(0);
  });

  it('starts for somebody whose shell exports NODE_ENV=development', () => {
    // The bundle chose a pretty-printing transport it cannot resolve and died in 400ms. Nothing in
    // the repository set this variable, so nothing in the repository could see it.
    const state = mkdtempSync(join(tmpdir(), 'sorema-bundle-'));
    run(['status'], 20_000, {}, state);
    pretendPaired(state);
    const result = run(['start'], 12_000, { NODE_ENV: 'development' }, state);
    const said = `${result.stdout}${result.stderr}`;

    expect(said).not.toMatch(/unable to determine transport target/);
    expect(said).toMatch(/listening/);
  });

  it('lets the command and the agent read the same identity', () => {
    // They read different environment variables for a while, so `status` reported the machine paired
    // while `start` reported it was not, and the service exited 1 every time it ran.
    const both = run(['status']);
    const started = run(['start'], 8_000);

    const saysPaired = both.stdout.includes('Paired as');
    const agentSaysUnpaired = `${started.stdout}${started.stderr}`.includes('not paired yet');
    expect(saysPaired && agentSaysUnpaired).toBe(false);
  });
});
