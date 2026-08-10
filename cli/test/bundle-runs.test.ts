import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeWorkspaceRoots } from '../src/workspace-roots.js';

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
  writeFileSync(
    file,
    JSON.stringify({ ...identity, deviceId: 'device-test', userId: 'user-test' }),
  );
}

function run(
  args: readonly string[],
  timeoutMs = 20_000,
  extra: Record<string, string> = {},
  state = mkdtempSync(join(tmpdir(), 'sorema-bundle-')),
  bundle = BUNDLE,
) {
  return spawnSync(process.execPath, [bundle, ...args], {
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
      // Its own port, because the developer running this very likely has the real agent installed
      // and listening on the default one. Sharing it made the test fail with EADDRINUSE on exactly
      // the machines where the product works — and pass on the ones where it does not.
      LOCAL_AGENT_PORT: String(18_000 + (process.pid % 4_000)),
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

    // Node writes `ExperimentalWarning: SQLite is an experimental feature and might change at any
    // time` to stderr the first time `node:sqlite` is loaded, on every version this command
    // supports — it was unflagged at 22.13 but not de-experimented. Harmless, and asserted here
    // rather than merely tolerated, because everything below reads the same stderr and the next
    // person to add a "nothing was written to stderr" assertion needs to meet this first.
    expect(result.stderr).toMatch(/ExperimentalWarning: SQLite is an experimental feature/);
    expect(said).not.toMatch(/Dynamic require/);
    expect(said).not.toMatch(/unable to determine transport target/);
    expect(said).not.toMatch(/Cannot find (module|package)/);
    // Both halves, because either one alone lies. Survival on its own is satisfied by a corpse: a
    // crashing logger holds the exit open for ten seconds. And "listening" on its own was satisfied
    // by an agent that printed it and then exited zero a millisecond later, because start returned
    // and the command called process.exit on the way out — which is how every paired machine came
    // to report itself never connected while its log read like success.
    expect(said).toMatch(/listening/);
    expect(result.signal).toBe('SIGTERM');
    expect(result.status).toBeNull();
    expect(ranForMs).toBeGreaterThan(10_000);
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

  /**
   * The defect end to end, through the published artefact and a real agent.
   *
   * `system.workspaces` is the capability the assistant is told about, and it was `misconfigured` on
   * every machine ever paired, because `LOCAL_AGENT_WORKSPACE_ROOTS` had no setter anywhere in this
   * system. Nothing here is stubbed: the folder is chosen through the command's own store, the built
   * bundle is what reads it, and the answer is taken off the agent's HTTP interface.
   */
  it('offers the chosen folder as projects, through the built command', async () => {
    const state = mkdtempSync(join(tmpdir(), 'sorema-projects-'));
    const code = join(state, 'CODE');
    mkdirSync(join(code, 'alpha'), { recursive: true });
    run(['status'], 20_000, {}, state);
    pretendPaired(state);
    writeWorkspaceRoots(state, [code]);

    // Its own port, for the same reason the rest of this file uses one: the developer running this
    // very likely has the real agent listening on the default.
    const port = String(22_000 + (process.pid % 4_000));
    const agent = spawn(process.execPath, [BUNDLE, 'start'], {
      // Started outside any checkout, the way the installed command is: it runs from the global npm
      // prefix, not from a repository. The agent loads a `.env` from whatever workspace it finds
      // above its working directory, and the private repository's own gitignored `.env` sets
      // `LOCAL_AGENT_WORKSPACE_ROOTS` — so with the cwd inherited, this test passed against a bundle
      // that had none of this in it. That file is also the reason the defect stayed invisible for so
      // long: projects appear when the agent is run from the checkout, and only from there.
      cwd: state,
      env: {
        ...process.env,
        NODE_ENV: undefined,
        USERPROFILE: state,
        HOME: state,
        SOREMA_API_URL: 'https://example.invalid',
        SOREMA_TUNNEL_URL: 'wss://example.invalid',
        LOCAL_AGENT_STATE_DIR: state,
        LOCAL_AGENT_DATABASE_URL: `file:${join(state, 'sorema.sqlite')}`,
        LOCAL_AGENT_PORT: port,
      },
    });

    try {
      let capabilities: { id: string; status: string; details?: Record<string, unknown> }[] = [];
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && capabilities.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const answer = await fetch(`http://127.0.0.1:${port}/capabilities`);
          capabilities = (
            (await answer.json()) as {
              capabilities: { id: string; status: string; details?: Record<string, unknown> }[];
            }
          ).capabilities;
        } catch {
          // Not listening yet.
        }
      }

      const workspaces = capabilities.find((entry) => entry.id === 'system.workspaces');
      // `misconfigured` is what every user got, and it is the machine saying out loud that it has
      // nowhere to work — which reached the conversation as "you have no projects".
      expect(workspaces?.status).toBe('ready');
      expect(JSON.stringify(workspaces?.details)).toContain('CODE');
    } finally {
      agent.kill('SIGTERM');
    }
  }, 40_000);

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

/**
 * Every real module specifier the bundle loads.
 *
 * esbuild writes import declarations at column zero and nothing else in the file starts a line that
 * way, which is what makes this precise where a search of the whole text is not: the bundle also
 * contains `import('../fastify')` inside JSDoc and `require("ajv/dist/runtime/equal")` inside the
 * strings ajv emits for standalone code generation. Both are indented, neither is ever loaded, and
 * a naive scan reports them and teaches everybody to ignore this check.
 */
function staticModuleSpecifiers(bundle: string): string[] {
  const specifiers = new Set<string>();
  for (const line of bundle.split('\n')) {
    if (!/^(import\b|export\b|\} from )/.test(line)) continue;
    const match = /(?:^import\s*|\bfrom\s*)["']([^"']+)["']/.exec(line);
    if (match?.[1]) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/**
 * What "no runtime dependencies" means, read off the artefact rather than off the manifest.
 *
 * The manifest is the claim, not the evidence: `cli/package.json` said `better-sqlite3` and the
 * bundle said `external: ['better-sqlite3']`, and the two agreeing is exactly how a package ends up
 * needing a native binding compiled for every platform it is published to. What is asserted here is
 * that the published file loads nothing but Node itself, and then that it really runs with no
 * node_modules within reach.
 */
describe.skipIf(!existsSync(BUNDLE))('the published package stands alone', () => {
  it('loads nothing but built-in modules', () => {
    const specifiers = staticModuleSpecifiers(readFileSync(BUNDLE, 'utf8'));

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
  });

  it('declares no dependencies to install beside it', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(manifest[field] ?? {}).toEqual({});
    }
  });

  it('reaches node:sqlite without naming it in an import, or the version check is unreachable', () => {
    const bundle = readFileSync(BUNDLE, 'utf8');

    // A static import is linked before any statement runs, so on Node 22.12 the process would die
    // with `No such built-in module: node:sqlite` and the sentence telling somebody to upgrade
    // would never be printed. The guard only works while the module is fetched late.
    expect(staticModuleSpecifiers(bundle)).not.toContain('node:sqlite');
    expect(bundle).toContain('getBuiltinModule("node:sqlite")');
  });

  it('runs, and stays running, from a folder with no node_modules anywhere above it', () => {
    // The whole file, copied out of the checkout to somewhere nothing can resolve for it. This is
    // the difference between a package that happens to work on the machine that built it and one
    // that works on a user's: `better-sqlite3` was installed here, so a bundle that still needed it
    // looked fine from inside the repository.
    const state = mkdtempSync(join(tmpdir(), 'sorema-alone-'));
    const alone = join(state, 'sorema.mjs');
    copyFileSync(BUNDLE, alone);
    run(['status'], 20_000, {}, state, alone);
    pretendPaired(state);

    const result = run(['start'], 12_000, {}, state, alone);
    const said = `${result.stdout}${result.stderr}`;

    expect(said).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|Dynamic require/);
    // Both halves, for the reason the file has been saying since the sixth broken release: the
    // evidence line on its own passed on an agent that printed it and exited, and survival on its
    // own passed on a corpse whose logger held the exit open.
    expect(said).toMatch(/listening/);
    expect(result.signal).toBe('SIGTERM');
    expect(result.status).toBeNull();
  });
});
