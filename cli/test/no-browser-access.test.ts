import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const commandsSource = readFileSync(
  fileURLToPath(new URL('../src/commands.ts', import.meta.url)),
  'utf8',
);
const claudeProviderSource = readFileSync(
  fileURLToPath(
    new URL('../../apps/local-agent/src/domains/coding/providers/claude-code-provider.ts', import.meta.url),
  ),
  'utf8',
);

/**
 * Browser access is out of the free beta, and out means unreachable rather than undocumented.
 *
 * Every other thing a coding agent does here is survivable because the user's own git history can
 * undo it. A browser acting through a signed-in profile is the one exception: an email sent from
 * their account, a form submitted, a purchase made, none of it comes back. The operator is one
 * person with no company between them and a claim, and this is the single feature that breaks the
 * "everything is reversible" defence the rest of the product rests on.
 *
 * A command that still exists is a feature still offered, whoever finds it. So the test is about
 * the path being gone, not about a default being off.
 */
describe('browser control is not in this build', () => {
  it('offers no command that could turn it on', () => {
    expect(mainSource).not.toContain("command === 'chrome'");
    expect(mainSource).not.toContain('sorema chrome enable');
    expect(mainSource).not.toContain('writeClaudeChromeAccess');
  });

  it('does not even reserve the word, which would make a pairing code beginning "chrome" a command', () => {
    expect(commandsSource).not.toContain("'chrome'");
  });

  it('never hands the flag to the coding agent, whatever a stale file or variable says', () => {
    expect(claudeProviderSource).not.toContain("'--chrome'");
    expect(claudeProviderSource).not.toContain('chromeEnabled');
  });

  /**
   * A machine that ran `sorema chrome enable` before this build still has the file and may still
   * have the variable in its service environment. Neither may bring the feature back, which is why
   * nothing reads them any more rather than reading them and ignoring the answer.
   */
  it('reads neither the durable consent file nor the environment variable', () => {
    expect(mainSource).not.toContain('readClaudeChromeAccess');
    expect(mainSource).not.toContain('CLAUDE_CODE_CHROME_ENABLED');
  });
});
