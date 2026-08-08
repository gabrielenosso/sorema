import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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
function run(args: readonly string[], timeoutMs = 20_000) {
  const state = mkdtempSync(join(tmpdir(), 'sorema-bundle-'));
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      SOREMA_API_URL: 'https://example.invalid',
      SOREMA_TUNNEL_URL: 'wss://example.invalid',
      LOCAL_AGENT_STATE_DIR: state,
      LOCAL_AGENT_DATABASE_URL: `file:${join(state, 'sorema.sqlite')}`,
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
    const startedAt = Date.now();
    const result = run(['start'], 12_000);
    const ranForMs = Date.now() - startedAt;
    const said = `${result.stdout}${result.stderr}`;

    expect(said).not.toMatch(/Dynamic require/);
    expect(said).not.toMatch(/unable to determine transport target/);
    expect(said).not.toMatch(/Cannot find (module|package)/);
    // How long it survived is the evidence. Every failure this test was written for exited in
    // milliseconds; a working agent stays up until the timeout kills it. Asserting on log lines
    // instead is fragile, because the process dies before its logger flushes.
    expect(ranForMs).toBeGreaterThan(5_000);
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
