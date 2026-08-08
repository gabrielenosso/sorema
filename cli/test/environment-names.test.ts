import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
