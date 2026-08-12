import { describe, expect, it } from 'vitest';
import { loadLocalAgentConfig } from '../src/index.js';

describe('Claude Code Chrome configuration', () => {
  it('keeps browser access off by default', () => {
    expect(loadLocalAgentConfig({} as NodeJS.ProcessEnv).claudeCodeChromeEnabled).toBe(false);
  });

  it.each(['true', '1'])('accepts the explicit opt-in %s', (value) => {
    expect(
      loadLocalAgentConfig({ CLAUDE_CODE_CHROME_ENABLED: value } as NodeJS.ProcessEnv)
        .claudeCodeChromeEnabled,
    ).toBe(true);
  });

  it.each(['false', '0', 'yes', ''])('does not treat %s as an opt-in', (value) => {
    expect(
      loadLocalAgentConfig({ CLAUDE_CODE_CHROME_ENABLED: value } as NodeJS.ProcessEnv)
        .claudeCodeChromeEnabled,
    ).toBe(false);
  });
});
