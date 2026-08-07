import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import { CodexCliProvider } from '../src/domains/coding/providers/codex-cli-provider.js';
import type { CodingTaskUpdate } from '../src/domains/coding/provider-types.js';
import {
  buildWindowsCommandLine,
  quoteWindowsArgument,
  resolveExecutablePath,
} from '../src/process/executable-resolver.js';

const STUB_CODEX_PATH = fileURLToPath(new URL('./fixtures/stub-codex.mjs', import.meta.url));
const silentLogger = createLogger('test', 'fatal', false);

function createProvider() {
  return new CodexCliProvider({
    executablePath: process.execPath,
    executableArguments: [STUB_CODEX_PATH],
    sandboxMode: 'workspace-write',
    stateDirectory: mkdtempSync(join(tmpdir(), 'ct-codex-run-')),
    jobTimeoutMs: 20_000,
    maxOutputBytes: 100_000,
    logger: silentLogger,
  });
}

async function runTask(
  provider: CodexCliProvider,
  instruction: string,
  providerSessionId?: string,
): Promise<CodingTaskUpdate[]> {
  const updates: CodingTaskUpdate[] = [];
  await provider.sendTask({
    jobId: `job_${Math.random().toString(16).slice(2)}`,
    instruction,
    session: {
      providerId: 'codex',
      providerSessionId,
      projectPath: tmpdir(),
      title: 'stub project',
      metadata: {},
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

describe('codex provider against a stub that speaks the real cli protocol', () => {
  it('detects the version and the flags the installed build actually supports', async () => {
    const detection = await createProvider().detect();
    expect(detection.available).toBe(true);
    expect(detection.status).toBe('ready');
    expect(detection.version).toContain('9.9.9-stub');
    expect(detection.details?.supportsWorkingDirectoryFlag).toBe(true);
    expect(detection.details?.supportsResume).toBe(true);
  });

  it('runs a task, reads the session id from the jsonl stream and reports progress', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'implement the health check endpoint');

    const sessionUpdate = updates.find((update) => update.kind === 'session_identified');
    expect(sessionUpdate).toBeDefined();
    if (sessionUpdate?.kind === 'session_identified') {
      expect(sessionUpdate.providerSessionId).toBe('11111111-2222-3333-4444-555555555555');
    }

    expect(updates.filter((update) => update.kind === 'progress').length).toBeGreaterThan(0);

    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('implement the health check endpoint');
      expect(terminal.spokenSummary.length).toBeLessThanOrEqual(320);
    }
  });

  it('passes the instruction on stdin rather than on the command line', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(
      provider,
      'add a probe && echo this text must never reach a shell',
    );
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('this text must never reach a shell');
    }
  });

  it('forces the sandbox mode on a fresh run, not trusting the global config', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'a fresh task');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('sandbox_mode="workspace-write"');
    }
  });

  it('forces the sandbox mode on resume too, where --sandbox does not exist', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'keep going', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('sandbox_mode="workspace-write"');
    }
  });

  it('resumes an existing provider session instead of starting a new one', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'keep going', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.summary).toContain('Continued the session');
      expect(terminal.details?.providerSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    }
  });

  it('turns a non-zero exit into a structured, speakable failure', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates = await runTask(provider, 'MAKE_ME_FAIL please');
    const terminal = updates.at(-1);
    expect(terminal?.kind).toBe('failed');
    if (terminal?.kind === 'failed') {
      expect(terminal.error.retryable).toBe(true);
      expect(terminal.error.userMessage).toBe(
        'The coding agent stopped with an error before finishing.',
      );
    }
  });

  it('stops a running task when it is cancelled', async () => {
    const provider = createProvider();
    await provider.detect();
    const updates: CodingTaskUpdate[] = [];
    const jobId = 'job_cancel_codex';
    await provider.sendTask({
      jobId,
      instruction: 'a task that will be stopped',
      session: {
        providerId: 'codex',
        projectPath: tmpdir(),
        title: 'stub project',
        metadata: {},
      },
      onUpdate: (update) => updates.push(update),
    });
    await provider.cancelTask(jobId);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (updates.some((update) => update.kind === 'completed' || update.kind === 'failed')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(updates.some((update) => update.kind === 'completed')).toBe(false);
  });
});

describe('executable resolution', () => {
  it('finds an executable that exists on PATH', () => {
    expect(resolveExecutablePath('node')).not.toBeNull();
  });

  it('returns nothing for an executable that does not exist', () => {
    expect(resolveExecutablePath('definitely-not-installed-anywhere-xyz')).toBeNull();
  });

  it('resolves an absolute path directly', () => {
    expect(resolveExecutablePath(process.execPath)).toBe(process.execPath);
  });

  it('quotes arguments that would otherwise break a command line', () => {
    expect(quoteWindowsArgument('C:/Program Files/x/codex.cmd')).toBe(
      '"C:/Program Files/x/codex.cmd"',
    );
    expect(quoteWindowsArgument('--json')).toBe('--json');
  });

  it('wraps the whole command line so cmd.exe /s does not eat the outer quotes', () => {
    expect(buildWindowsCommandLine('C:\\Program Files\\nodejs\\claude.CMD', ['--version'])).toBe(
      '""C:\\Program Files\\nodejs\\claude.CMD" --version"',
    );
  });
});
