import { describe, expect, it } from 'vitest';
import { loadLocalAgentConfig } from '../src/index.js';

/**
 * Browser control was removed from this build, and the configuration must not be able to bring it
 * back. A machine that ran the old `sorema chrome enable` still has `CLAUDE_CODE_CHROME_ENABLED` in
 * its service environment, so the test that matters is that setting it changes nothing at all.
 */
describe('the configuration a machine is started with', () => {
  it.each(['true', '1', 'false', ''])(
    'has no browser setting to read, whatever the old variable says (%s)',
    (value) => {
      const config = loadLocalAgentConfig({
        CLAUDE_CODE_CHROME_ENABLED: value,
      } as NodeJS.ProcessEnv);

      expect(Object.keys(config)).not.toContain('claudeCodeChromeEnabled');
      expect(JSON.stringify(config)).not.toContain('chrome');
    },
  );
});
