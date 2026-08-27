import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePairingCode } from '../../packages/security/src/pairing.js';
import { COMMAND_WORDS, looksLikePairingCode } from '../src/commands.js';

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
 * The rule is the command's own function rather than a copy of it, because a test carrying its own
 * copy agrees with itself no matter what the command does — which is how the two halves of every
 * other boundary in this project managed to disagree for weeks.
 *
 * Two pairing-code alphabets exist here and only one is live. Both must get through, and the one
 * that would not was the dashed form: the command answered "No command called KQZM-W7PT", which
 * reads like a typo rather than a validator turning away a code the system issued itself.
 */
describe('the command accepts the codes this system can issue', () => {
  it.each(['6D246143', 'BD37A99A', 'KQZM-W7PT', 'KQZMW7PT'])('takes %s as a code', (code) => {
    expect(looksLikePairingCode(code)).toBe(true);
  });

  /**
   * Lengths the service does not issue today. Pinned at exactly eight, a code lengthened on the
   * server would reach a machine running an older release as "no such command" — a message about the
   * wrong thing entirely, on the one screen where somebody has no way to tell what went wrong. The
   * length is the service's business; this only has to recognise the shape.
   */
  it.each(['6D246143AB', '6D246143ABCD', '6D24-6143-ABCD', 'A1B2C3'])(
    'takes %s, a length this build does not issue',
    (code) => {
      expect(looksLikePairingCode(code)).toBe(true);
    },
  );

  it.each(['abc', 'a'.repeat(17), 'has space', 'has_underscore', ''])(
    'refuses %s, which no code has ever looked like',
    (value) => {
      expect(looksLikePairingCode(value)).toBe(false);
    },
  );

  it('accepts every code the generator in this repository produces', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(looksLikePairingCode(generatePairingCode())).toBe(true);
    }
  });

  it('still refuses the words that are commands', () => {
    for (const command of COMMAND_WORDS) {
      expect(looksLikePairingCode(command)).toBe(false);
    }
  });

  /**
   * The collision the other way round, which shipped the moment a command was named an eight-letter
   * word. `projects` matches the code shape exactly, so `sorema projects` was sent to the pairing
   * endpoint and came back `fetch failed` — no mention of projects, no mention of pairing.
   *
   * Scraped from the dispatch rather than listed here: a list written in a test is a second copy of
   * the truth, and the next command added would collide in silence exactly as this one did.
   */
  it('knows about every word the command dispatches on', () => {
    const dispatched = new Set(
      Array.from(cliSource.matchAll(/command === '([a-z-]+)'/g), (match) => match[1] ?? ''),
    );

    expect(dispatched.size).toBeGreaterThan(0);
    for (const word of dispatched) {
      expect([...COMMAND_WORDS]).toContain(word);
    }
  });
});
