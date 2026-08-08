import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePairingCode } from '../../packages/security/src/pairing.js';

const here = import.meta.dirname;
const cliSource = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
const configSource = readFileSync(
  join(here, '..', '..', 'packages', 'config', 'src', 'index.ts'),
  'utf8',
);

function namesIn(source: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(source.matchAll(pattern), (match) => match[1] ?? ''));
}

/**
 * The two halves of the command must name the same variables.
 *
 * They did not, and the result was a machine that answered its own question two ways: `sorema status`
 * reported it paired while `sorema start` reported it was not, because the identity was written to
 * one directory and looked for in another. The service exited 1 on every run and the web app showed
 * the machine as never connected. Nothing failed — each half agreed with itself.
 *
 * Read from the sources rather than by importing them, because importing the config would need its
 * whole dependency tree and this only needs the names.
 */
describe('the command and the agent name the same settings', () => {
  const setByCli = namesIn(cliSource, /process\.env\.([A-Z_]+) \?\?=/g);
  // Captured whole, then filtered: a negative lookahead makes the greedy match give back a
  // character to satisfy itself, so `LOCAL_AGENT_STATE_DIR` arrives as `LOCAL_AGENT_STATE_DI`.
  const readByCli = new Set(
    Array.from(cliSource.matchAll(/process\.env\.([A-Z_]+)(\s*\?\?=)?/g))
      .filter((match) => match[2] === undefined)
      .map((match) => match[1] ?? ''),
  );
  const readByConfig = namesIn(configSource, /environment\.([A-Z_]+)/g);

  // Set by the CLI purely for its own use, never handed to the agent's configuration.
  const cliOnly = new Set(['NODE_ENV', 'SOREMA_API_URL']);

  it.each([...setByCli].filter((name) => !cliOnly.has(name)))(
    'the agent configuration reads %s, which the command sets',
    (name) => {
      expect(readByConfig.has(name)).toBe(true);
    },
  );

  it('never reads a name it does not also set', () => {
    const orphans = [...readByCli].filter(
      (name) => !setByCli.has(name) && !cliOnly.has(name) && name.startsWith('LOCAL_AGENT'),
    );

    // A read without a matching set is how the device name reached the server as "undefined".
    expect(orphans).toEqual([]);
  });
});

/**
 * Ties the two halves of pairing together.
 *
 * The pattern is lifted out of the command's own source rather than copied here, because a test
 * carrying its own copy of the rule agrees with itself no matter what the command does — which is
 * how the two halves of every other boundary in this project managed to disagree for weeks.
 *
 * Two pairing-code alphabets exist here and only one is live. Both must get through, and the one
 * that would not was the dashed form: the command answered "No command called KQZM-W7PT", which
 * reads like a typo rather than a validator turning away a code the system issued itself.
 */
describe('the command accepts the codes this system can issue', () => {
  const source = /looksLikeCode = command !== undefined && (\/.+\/)\.test/.exec(cliSource);
  const looksLikeCode = new RegExp(String(source?.[1]).slice(1, -1));

  it('reads its rule out of the command', () => {
    expect(source).not.toBeNull();
  });

  it.each(['6D246143', 'BD37A99A', 'KQZM-W7PT', 'KQZMW7PT'])('takes %s as a code', (code) => {
    expect(looksLikeCode.test(code)).toBe(true);
  });

  it('accepts every code the generator in this repository produces', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(looksLikeCode.test(generatePairingCode())).toBe(true);
    }
  });

  it('still refuses the words that are commands', () => {
    for (const command of ['status', 'start', 'pair', 'help', 'service']) {
      expect(looksLikeCode.test(command)).toBe(false);
    }
  });
});
