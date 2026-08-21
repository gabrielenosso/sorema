import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import { CodexCliProvider } from '../src/domains/coding/providers/codex-cli-provider.js';
import { ClaudeCodeProvider } from '../src/domains/coding/providers/claude-code-provider.js';
import type { CodingProvider, CodingTaskUpdate } from '../src/domains/coding/provider-types.js';

const runLive = process.env.SOREMA_LIVE_CLI_TEST === '1' ? it : it.skip;
const logger = createLogger('live-coding-provider-test', 'fatal', false);

async function runReadOnlySmoke(provider: CodingProvider): Promise<CodingTaskUpdate[]> {
  const projectPath = mkdtempSync(join(tmpdir(), `sorema-${provider.providerId}-smoke-`));
  const session = await provider.createSession({
    projectPath,
    title: `${provider.providerId} live smoke test`,
  });
  const updates: CodingTaskUpdate[] = [];
  await provider.sendTask({
    jobId: `job_live_${provider.providerId}_${Date.now()}`,
    instruction:
      'This is a connectivity test. Do not create, edit, or delete files. Reply with exactly SOREMA_CLI_OK.',
    session,
    onUpdate: (update) => updates.push(update),
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (updates.some((update) => update.kind === 'completed' || update.kind === 'failed')) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return updates;
}

function expectSuccessfulSmoke(updates: CodingTaskUpdate[]): void {
  const terminal = updates.findLast(
    (update) => update.kind === 'completed' || update.kind === 'failed',
  );
  expect(
    terminal,
    `No terminal update was received. Updates: ${JSON.stringify(updates)}`,
  ).toBeDefined();
  expect(terminal?.kind, JSON.stringify(terminal)).toBe('completed');
  if (terminal?.kind === 'completed') expect(terminal.summary).toContain('SOREMA_CLI_OK');
}

describe('the real coding CLIs installed on this machine', () => {
  runLive(
    'starts and completes a read-only Codex task through the Sorema provider',
    async () => {
      const provider = new CodexCliProvider({
        executablePath: 'codex',
        sandboxMode: 'read-only',
        stateDirectory: mkdtempSync(join(tmpdir(), 'sorema-codex-state-')),
        jobTimeoutMs: 120_000,
        maxOutputBytes: 100_000,
        logger,
      });
      expect(await provider.detect()).toMatchObject({ available: true, status: 'ready' });
      expectSuccessfulSmoke(await runReadOnlySmoke(provider));
    },
    140_000,
  );

  runLive(
    'starts and completes a no-edit Claude task through the Sorema provider',
    async () => {
      const provider = new ClaudeCodeProvider({
        executablePath: 'claude',
        chromeEnabled: false,
        stateDirectory: mkdtempSync(join(tmpdir(), 'sorema-claude-state-')),
        jobTimeoutMs: 120_000,
        maxOutputBytes: 100_000,
        logger,
      });
      expect(await provider.detect()).toMatchObject({ available: true, status: 'ready' });
      expectSuccessfulSmoke(await runReadOnlySmoke(provider));
    },
    140_000,
  );
});
