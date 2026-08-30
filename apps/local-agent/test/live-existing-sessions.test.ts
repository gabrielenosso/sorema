import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import { CodexCliProvider } from '../src/domains/coding/providers/codex-cli-provider.js';
import { ClaudeCodeProvider } from '../src/domains/coding/providers/claude-code-provider.js';

const logger = createLogger('live', 'fatal', false);
const PROJECT = process.env.SOREMA_LIVE_PROJECT ?? '';

describe.skipIf(!PROJECT)('what the installed agents really answer', () => {
  it('codex lists its own threads for the project', async () => {
    const provider = new CodexCliProvider({
      executablePath: 'codex',
      sandboxMode: 'workspace-write',
      stateDirectory: join(tmpdir(), 'sorema-live'),
      jobTimeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
      logger,
    });
    const sessions = await provider.listExistingSessions({ projectPath: PROJECT, limit: 10 });
    console.log('codex:', sessions);
    expect(Array.isArray(sessions)).toBe(true);
  }, 60_000);

  it('claude lists its own transcripts for the project', async () => {
    const provider = new ClaudeCodeProvider({
      executablePath: 'claude',
      stateDirectory: join(tmpdir(), 'sorema-live'),
      jobTimeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
      logger,
    });
    const sessions = await provider.listExistingSessions({ projectPath: PROJECT, limit: 10 });
    console.log('claude:', sessions);
    expect(Array.isArray(sessions)).toBe(true);
  }, 60_000);
});
