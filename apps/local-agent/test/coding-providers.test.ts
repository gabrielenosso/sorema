import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import {
  CodexCliProvider,
  buildSpokenSummary,
  describeCodexEvent,
  findSessionIdentifier,
  parseSupportedFlags,
} from '../src/domains/coding/providers/codex-cli-provider.js';
import { FakeCodingProvider } from '../src/domains/coding/providers/fake-coding-provider.js';
import type { CodingTaskUpdate } from '../src/domains/coding/provider-types.js';

const silentLogger = createLogger('test', 'fatal', false);

function collectUpdates(): {
  updates: CodingTaskUpdate[];
  onUpdate: (u: CodingTaskUpdate) => void;
} {
  const updates: CodingTaskUpdate[] = [];
  return { updates, onUpdate: (update) => updates.push(update) };
}

async function waitForTerminalUpdate(updates: CodingTaskUpdate[], timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = updates.find(
      (update) => update.kind === 'completed' || update.kind === 'failed',
    );
    if (terminal) return terminal;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`no terminal update within ${timeoutMs}ms: ${JSON.stringify(updates)}`);
}

describe('codex jsonl parsing', () => {
  it('finds a session identifier at the top level', () => {
    expect(findSessionIdentifier({ session_id: '3f1c9c8c-4f1e-4f1e-8f1e-4f1e4f1e4f1e' })).toBe(
      '3f1c9c8c-4f1e-4f1e-8f1e-4f1e4f1e4f1e',
    );
  });

  it('finds a session identifier nested inside a message envelope', () => {
    expect(
      findSessionIdentifier({
        id: '0',
        msg: { type: 'session_configured', session_id: '11111111-2222-3333-4444-555555555555' },
      }),
    ).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('accepts the thread_id naming used by newer builds', () => {
    expect(
      findSessionIdentifier({
        type: 'thread.started',
        thread_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('ignores values that are not identifiers', () => {
    expect(findSessionIdentifier({ session_id: 'not-a-uuid' })).toBeNull();
    expect(findSessionIdentifier({ note: 'nothing here' })).toBeNull();
  });

  it('turns known events into a short human description', () => {
    expect(describeCodexEvent({ type: 'item.completed', item: { item_type: 'patch' } })).toBe(
      'editing files',
    );
    expect(describeCodexEvent({ type: 'turn.completed' })).toBeNull();
  });

  it('reads the supported flags out of a help screen', () => {
    const flags = parseSupportedFlags('  --json\n  -o, --output-last-message <FILE>\n  --cd <DIR>');
    expect(flags.has('--json')).toBe(true);
    expect(flags.has('--output-last-message')).toBe(true);
    expect(flags.has('--sandbox')).toBe(false);
  });

  it('shortens a long summary for speech', () => {
    const summary = buildSpokenSummary(`${'word '.repeat(200)}\n\nsecond paragraph`);
    expect(summary.length).toBeLessThanOrEqual(320);
    expect(summary).not.toContain('second paragraph');
  });
});

describe('codex provider when the cli is missing', () => {
  const provider = new CodexCliProvider({
    executablePath: join(tmpdir(), 'definitely-not-a-real-codex-binary'),
    sandboxMode: 'workspace-write',
    stateDirectory: mkdtempSync(join(tmpdir(), 'ct-codex-')),
    jobTimeoutMs: 5_000,
    maxOutputBytes: 10_000,
    logger: silentLogger,
  });

  it('reports itself as missing instead of throwing', async () => {
    const detection = await provider.detect();
    expect(detection.available).toBe(false);
    expect(detection.status).toBe('missing');
  });

  it('emits a structured failure instead of crashing when a task is sent', async () => {
    const { updates, onUpdate } = collectUpdates();
    await provider.sendTask({
      jobId: 'job_1',
      instruction: 'add a health check endpoint',
      session: {
        providerId: 'codex',
        projectPath: tmpdir(),
        title: 'demo',
        metadata: {},
      },
      onUpdate,
    });
    const terminal = await waitForTerminalUpdate(updates);
    expect(terminal.kind).toBe('failed');
    if (terminal.kind === 'failed') {
      expect(terminal.error.code).toBe('CODING_PROVIDER_NOT_INSTALLED');
      expect(terminal.error.userMessage).not.toContain('Error:');
    }
  });
});

describe('fake coding provider', () => {
  it('is always available', async () => {
    expect((await new FakeCodingProvider().detect()).available).toBe(true);
  });

  it('reports progress and then completes', async () => {
    const provider = new FakeCodingProvider({ stepDelayMs: 10 });
    const { updates, onUpdate } = collectUpdates();
    const session = await provider.createSession({ projectPath: '/tmp/demo', title: 'demo' });
    await provider.sendTask({ jobId: 'job_1', session, instruction: 'add health check', onUpdate });

    const terminal = await waitForTerminalUpdate(updates);
    expect(updates.filter((update) => update.kind === 'progress').length).toBeGreaterThan(1);
    expect(terminal.kind).toBe('completed');
    if (terminal.kind === 'completed') {
      expect(terminal.spokenSummary).toContain('add health check');
    }
  });

  it('emits exactly one terminal update', async () => {
    const provider = new FakeCodingProvider({ stepDelayMs: 5 });
    const { updates, onUpdate } = collectUpdates();
    const session = await provider.createSession({ projectPath: '/tmp/demo', title: 'demo' });
    await provider.sendTask({ jobId: 'job_1', session, instruction: 'anything', onUpdate });
    await waitForTerminalUpdate(updates);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    expect(
      updates.filter((update) => update.kind === 'completed' || update.kind === 'failed'),
    ).toHaveLength(1);
  });

  it('fails on demand so failure paths can be demonstrated', async () => {
    const provider = new FakeCodingProvider({ stepDelayMs: 5 });
    const { updates, onUpdate } = collectUpdates();
    const session = await provider.createSession({ projectPath: '/tmp/demo', title: 'demo' });
    await provider.sendTask({
      jobId: 'job_1',
      session,
      instruction: 'please fail on purpose',
      onUpdate,
    });
    const terminal = await waitForTerminalUpdate(updates);
    expect(terminal.kind).toBe('failed');
  });

  it('keeps the provider session id when resuming', async () => {
    const provider = new FakeCodingProvider({ stepDelayMs: 5 });
    const created = await provider.createSession({ projectPath: '/tmp/demo', title: 'demo' });
    const resumed = await provider.resumeSession({
      providerSessionId: created.providerSessionId,
      projectPath: '/tmp/demo',
      title: 'demo',
    });
    expect(resumed.providerSessionId).toBe(created.providerSessionId);
  });

  it('stops a running task when cancelled', async () => {
    const provider = new FakeCodingProvider({ stepDelayMs: 30 });
    const { updates, onUpdate } = collectUpdates();
    const session = await provider.createSession({ projectPath: '/tmp/demo', title: 'demo' });
    await provider.sendTask({ jobId: 'job_cancel', session, instruction: 'long task', onUpdate });
    await provider.cancelTask('job_cancel');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(updates.some((update) => update.kind === 'completed')).toBe(false);
    expect((await provider.getTaskStatus('job_cancel')).running).toBe(false);
  });
});
