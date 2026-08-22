import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import { ClaudeCodeProvider } from '../src/domains/coding/providers/claude-code-provider.js';
import type { CodingTaskUpdate } from '../src/domains/coding/provider-types.js';

const STUB_CLAUDE_PATH = fileURLToPath(new URL('./fixtures/stub-claude.mjs', import.meta.url));
const silentLogger = createLogger('test', 'fatal', false);

function createProvider(
  options: { chromeEnabled?: boolean; supportsChrome?: boolean; loggedIn?: boolean } = {},
) {
  return new ClaudeCodeProvider({
    executablePath: process.execPath,
    executableArguments: [
      STUB_CLAUDE_PATH,
      ...(options.supportsChrome === false ? ['--stub-no-chrome'] : []),
      ...(options.loggedIn === false ? ['--stub-logged-out'] : []),
    ],
    chromeEnabled: options.chromeEnabled,
    stateDirectory: mkdtempSync(join(tmpdir(), 'ct-claude-run-')),
    jobTimeoutMs: 20_000,
    maxOutputBytes: 100_000,
    logger: silentLogger,
  });
}

function notARepository(): string {
  return mkdtempSync(join(tmpdir(), 'ct-claude-plain-'));
}

/**
 * Every other test in this file used the bare temp directory, which git does not track. Once the
 * provider started refusing those, they would all have failed for a reason none of them is about.
 */
function aRepository(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ct-claude-repo-'));
  mkdirSync(join(folder, '.git'), { recursive: true });
  return folder;
}

async function runTask(
  provider: ClaudeCodeProvider,
  instruction: string,
  session: {
    providerSessionId?: string;
    metadata?: Record<string, unknown>;
    projectPath?: string;
  } = {},
): Promise<CodingTaskUpdate[]> {
  const updates: CodingTaskUpdate[] = [];
  await provider.sendTask({
    jobId: `job_${Math.random().toString(16).slice(2)}`,
    instruction,
    session: {
      providerId: 'claude',
      providerSessionId: session.providerSessionId,
      projectPath: session.projectPath ?? aRepository(),
      title: 'stub project',
      metadata: session.metadata ?? {},
    },
    onUpdate: (update) => updates.push(update),
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (updates.some((update) => update.kind === 'completed' || update.kind === 'failed')) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return updates;
}

describe('claude code provider against a stub that speaks the real cli protocol', () => {
  it('detects the version and the flags the installed build supports', async () => {
    const detection = await createProvider().detect();
    expect(detection.available).toBe(true);
    expect(detection.status).toBe('ready');
    expect(detection.version).toContain('9.9.9-stub');
    expect(detection.details).toMatchObject({
      supportsResume: true,
      supportsPreassignedSessionId: true,
      supportsChrome: true,
      chromeAccessRequested: false,
      chromeAccessEnabled: false,
    });
  });

  it('only enables Chrome after an explicit opt-in', async () => {
    const provider = createProvider({ chromeEnabled: true });
    const detection = await provider.detect();
    expect(detection.details).toMatchObject({
      supportsChrome: true,
      chromeAccessRequested: true,
      chromeAccessEnabled: true,
    });

    const updates = await runTask(provider, 'use the browser');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') expect(terminal.summary).toContain('--chrome');
  });

  it('does not pass --chrome when the installed Claude CLI lacks support', async () => {
    const provider = createProvider({ chromeEnabled: true, supportsChrome: false });
    const detection = await provider.detect();
    expect(detection.available).toBe(true);
    expect(detection.details).toMatchObject({
      supportsChrome: false,
      chromeAccessRequested: true,
      chromeAccessEnabled: false,
    });

    const updates = await runTask(provider, 'use the browser');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary.split('flags: ')[1]).not.toContain('--chrome');
    }
  });

  it('reports missing when the binary is absent', async () => {
    const provider = new ClaudeCodeProvider({
      executablePath: 'claude-that-does-not-exist',
      stateDirectory: mkdtempSync(join(tmpdir(), 'ct-claude-missing-')),
      jobTimeoutMs: 5_000,
      maxOutputBytes: 1_000,
      logger: silentLogger,
    });
    const detection = await provider.detect();
    expect(detection.available).toBe(false);
    expect(detection.status).toBe('missing');
    expect(detection.details).toMatchObject({
      supportsChrome: false,
      chromeAccessRequested: false,
      chromeAccessEnabled: false,
    });
  });

  it('reports misconfigured instead of ready when Claude is not logged in', async () => {
    const detection = await createProvider({ loggedIn: false }).detect();
    expect(detection.available).toBe(false);
    expect(detection.status).toBe('misconfigured');
    expect(detection.details).toMatchObject({ authenticated: false });
  });

  it('assigns a session id up front instead of scraping it from the output', async () => {
    const session = await createProvider().createSession({
      projectPath: tmpdir(),
      title: 'demo',
    });
    expect(session.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('runs a task, reports progress and finishes with the result text', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'add a health check', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    expect(updates[0]?.kind).toBe('started');
    const progressMessages = updates
      .filter((update) => update.kind === 'progress')
      .map((update) => (update.kind === 'progress' ? update.message : ''));
    expect(progressMessages).toContain('running a command');
    expect(progressMessages).toContain('editing files');

    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('add a health check');
      expect(terminal.spokenSummary.length).toBeGreaterThan(0);
    }
  });

  it('passes the instruction on stdin rather than on the command line', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'a secret instruction', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const terminal = updates.at(-1);
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('a secret instruction');
      expect(terminal.summary.split('flags: ')[1]).not.toContain('a secret instruction');
    }
  });

  it('never passes the flag that would disable permission checks', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'do something', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const terminal = updates.at(-1);
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).not.toContain('--dangerously-skip-permissions');
      expect(terminal.summary).not.toContain('--add-dir');
      expect(terminal.summary).toContain('--permission-mode acceptEdits');
    }
  });

  it('resumes an existing session instead of starting a new one', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'keep going', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      metadata: { resumedAt: new Date().toISOString() },
    });
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('Continued the session');
      expect(terminal.summary).toContain('--resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    }
  });

  it('turns a reported failure into a structured, speakable error', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'MAKE_ME_FAIL please', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('failed');
    if (terminal?.kind === 'failed') {
      expect(terminal.error.userMessage).not.toContain('exit');
      expect(terminal.error.message).toContain('did not compile');
      expect(terminal.error.retryable).toBe(true);
    }
  });

  it('stops a running task when it is cancelled', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates: CodingTaskUpdate[] = [];
    await provider.sendTask({
      jobId: 'job_cancel_claude',
      instruction: 'long running work',
      session: {
        providerId: 'claude',
        providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        projectPath: tmpdir(),
        title: 'stub project',
        metadata: {},
      },
      onUpdate: (update) => updates.push(update),
    });
    await provider.cancelTask('job_cancel_claude');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(updates.some((update) => update.kind === 'completed')).toBe(false);
    expect((await provider.getTaskStatus('job_cancel_claude')).running).toBe(false);
  });

  /**
   * Claude Code has no operating-system sandbox and no git requirement of its own, so both of the
   * things Codex gets for free have to be asked for here. The network denial matters most: with
   * Bash available an unattended job can push, publish or send, and none of that is undone by any
   * amount of local history.
   */
  it('denies the tools that reach off the machine', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'do something', {
      providerSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const terminal = updates.at(-1);
    // Asserted first: every assertion below sits inside the narrowing, so a run that ended any
    // other way would pass this test without checking anything.
    expect(terminal?.kind).toBe('completed');

    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('--disallowed-tools');
      expect(terminal.summary).toMatch(/WebFetch|WebSearch/);
      expect(terminal.summary).toContain('Bash(git push:*)');
    }
  });

  /**
   * The undo for a job that goes wrong is the user's own git history, which is why Codex refuses to
   * run outside a repository at all. Claude Code has no such refusal of its own, so a deletion in a
   * plain folder is simply gone. The registry already records whether a project is a repository and
   * nothing acted on it, which left the recovery story true for one provider and false for the other.
   */
  it('refuses a folder that git is not tracking', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'do something', { projectPath: notARepository() });
    const terminal = updates.at(-1);

    expect(terminal?.kind).toBe('failed');
    if (terminal?.kind === 'failed') {
      expect(terminal.error.userMessage).toMatch(/git/i);
    }
  });

  /**
   * The deny list is the only confinement this provider has against the actions local history
   * cannot undo. An older CLI that does not advertise the flag would previously have been given the
   * job anyway, silently, with nothing withheld from it.
   */
  it('refuses to start at all when the installed cli has no deny list to pass', async () => {
    const provider = new ClaudeCodeProvider({
      executablePath: process.execPath,
      executableArguments: [STUB_CLAUDE_PATH, '--stub-no-deny-list'],
      stateDirectory: mkdtempSync(join(tmpdir(), 'ct-claude-old-')),
      jobTimeoutMs: 20_000,
      maxOutputBytes: 100_000,
      logger: silentLogger,
    });
    await provider.detect();
    const updates = await runTask(provider, 'do something');
    const terminal = updates.at(-1);

    expect(terminal?.kind).toBe('failed');
    if (terminal?.kind === 'failed') {
      expect(terminal.error.userMessage).toMatch(/update|newer|older|version/i);
    }
  });
});
