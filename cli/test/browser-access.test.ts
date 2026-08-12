import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalAgentConfig } from '../../packages/config/src/index.js';
import {
  browserAccessFilePath,
  readClaudeChromeAccess,
  writeClaudeChromeAccess,
} from '../src/browser-access.js';

function temporaryState(): string {
  return mkdtempSync(join(tmpdir(), 'sorema-browser-access-'));
}

describe('durable Claude Code Chrome consent', () => {
  it('fails closed when no choice has been stored', () => {
    expect(readClaudeChromeAccess(temporaryState())).toBe(false);
  });

  it('round-trips enable and disable', () => {
    const state = temporaryState();
    writeClaudeChromeAccess(state, true);
    expect(readClaudeChromeAccess(state)).toBe(true);
    writeClaudeChromeAccess(state, false);
    expect(readClaudeChromeAccess(state)).toBe(false);
  });

  it('fails closed for malformed or ambiguous state', () => {
    const state = temporaryState();
    writeFileSync(browserAccessFilePath(state), '{broken');
    expect(readClaudeChromeAccess(state)).toBe(false);
    writeFileSync(browserAccessFilePath(state), JSON.stringify({ claudeCodeEnabled: 'true' }));
    expect(readClaudeChromeAccess(state)).toBe(false);
  });

  it('hands persisted consent to a freshly loaded agent configuration', () => {
    const state = temporaryState();
    writeClaudeChromeAccess(state, true);

    // This is the boundary a new `sorema start` process crosses in applyDefaults: disk is read
    // afresh and only then translated into the configuration consumed by the provider.
    const config = loadLocalAgentConfig({
      CLAUDE_CODE_CHROME_ENABLED: readClaudeChromeAccess(state) ? 'true' : 'false',
    } as NodeJS.ProcessEnv);
    expect(config.claudeCodeChromeEnabled).toBe(true);
  });

  it('stores the authority decision in an owner-only file where supported', () => {
    const state = temporaryState();
    writeClaudeChromeAccess(state, true);
    if (process.platform !== 'win32') {
      expect(statSync(browserAccessFilePath(state)).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(browserAccessFilePath(state)).isFile()).toBe(true);
    }
  });

  it.runIf(process.platform !== 'win32')('restricts an existing broadly readable file', () => {
    const state = temporaryState();
    writeClaudeChromeAccess(state, false);
    chmodSync(browserAccessFilePath(state), 0o644);

    writeClaudeChromeAccess(state, true);

    expect(statSync(browserAccessFilePath(state)).mode & 0o777).toBe(0o600);
  });
});
