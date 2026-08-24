import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MachineMemory } from '../src/memory/machine-memory.js';

let stateDirectory: string;
let memory: MachineMemory;

beforeEach(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'ct-memory-'));
  memory = new MachineMemory(stateDirectory);
});

function fileContents(): string {
  return readFileSync(join(stateDirectory, 'memory.md'), 'utf8');
}

/**
 * Notes kept on the user's own computer instead of in the cloud, which is what removes the whole
 * Article 9 question from the hosted service: nothing about a subject somebody raised is stored by
 * the operator at all.
 *
 * Markdown, and one plain file, on purpose. It is the format the coding agents on this machine
 * already read, so the same notes can be handed to them later without a conversion; and it is the
 * only storage format a person can open, check and correct without asking anybody for a feature.
 */
describe('notes kept on this machine', () => {
  it('writes a note under its subject, in a file a person can read', async () => {
    await memory.remember('back garden', 'the fence needs replacing before winter');

    expect(fileContents()).toContain('## back garden');
    expect(fileContents()).toContain('the fence needs replacing before winter');
  });

  it('adds a second note to the subject it belongs to rather than repeating the heading', async () => {
    await memory.remember('back garden', 'the fence needs replacing');
    await memory.remember('back garden', 'the shed door sticks');

    const contents = fileContents();
    expect(contents.match(/## back garden/g)).toHaveLength(1);
    expect(contents).toContain('the fence needs replacing');
    expect(contents).toContain('the shed door sticks');
  });

  it('keeps different subjects apart', async () => {
    await memory.remember('back garden', 'the fence needs replacing');
    await memory.remember('the car', 'service due in March');

    expect(fileContents()).toContain('## back garden');
    expect(fileContents()).toContain('## the car');
  });

  it('reads back everything under a subject when asked about it', async () => {
    await memory.remember('back garden', 'the fence needs replacing');
    await memory.remember('back garden', 'the shed door sticks');

    const recalled = await memory.recall('garden');

    expect(recalled.threads).toHaveLength(1);
    expect(recalled.threads[0]?.title).toBe('back garden');
    expect(recalled.threads[0]?.recentEntries.map((entry) => entry.text)).toEqual([
      'the fence needs replacing',
      'the shed door sticks',
    ]);
  });

  it('finds a subject by a word inside one of its notes, not only by its title', async () => {
    await memory.remember('the car', 'the timing belt is due at 90 thousand');

    const recalled = await memory.recall('timing belt');

    expect(recalled.threads[0]?.title).toBe('the car');
  });

  it('says plainly that it found nothing rather than returning an empty answer', async () => {
    const recalled = await memory.recall('anything at all');

    expect(recalled.threads).toEqual([]);
    expect(recalled.spokenSummary.toLowerCase()).toContain('nothing');
  });

  /**
   * The file belongs to the person, not to this process. Somebody who opens it, rewrites a line and
   * saves it must get their correction back, and must not have it overwritten by an in-memory copy
   * from before they edited it. Article 16 answered by a text editor.
   */
  it('reads whatever is in the file now, including a correction made by hand', async () => {
    await memory.remember('the car', 'service due in March');
    writeFileSync(
      join(stateDirectory, 'memory.md'),
      '## the car\n\n- service due in September\n',
      'utf8',
    );

    const recalled = await memory.recall('car');

    expect(recalled.threads[0]?.recentEntries.map((entry) => entry.text)).toEqual([
      'service due in September',
    ]);
  });

  it('starts from nothing when the file does not exist yet', async () => {
    await expect(memory.recall('anything')).resolves.toMatchObject({ threads: [] });
  });
});
