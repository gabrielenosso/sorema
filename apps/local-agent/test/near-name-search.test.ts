import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../src/projects/project-registry.js';

let workspaceRoot: string;
let registry: ProjectRegistry;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'ct-near-'));
  registry = new ProjectRegistry([workspaceRoot]);
  for (const name of ['hooch', 'incremental-geometry', 'sorema-cloud', 'xai']) {
    registry.createProject(name);
  }
});

const names = (search: string) => registry.listProjects(search).map((project) => project.name);

/**
 * A microphone that cannot carry a project name is the ordinary case, not the exception.
 *
 * One recorded conversation went: the user says a name, the assistant hears `hawk`, finds nothing,
 * hears `hoch`, finds nothing, hears `hoch with two o`, finds nothing. The project was `hooch` and it
 * was on the machine the whole time. Exact and substring matching answers "no" to every one of those,
 * which is true and useless — the person is not asking whether their spelling exists.
 */
describe('finding a project whose name was misheard', () => {
  it('still finds the exact name, which must not regress', () => {
    expect(names('hooch')).toEqual(['hooch']);
  });

  it('still finds it by a part of the name', () => {
    expect(names('geometry')).toEqual(['incremental-geometry']);
  });

  it.each(['hoch', 'hooc', 'huch', 'hoochh'])('finds hooch from %s', (misheard) => {
    expect(names(misheard)).toContain('hooch');
  });

  /**
   * `hawk` is what the recogniser actually produced for `hooch`. No spelling threshold reaches it —
   * four letters, three of them different — and this file said so for an afternoon. It is a phonetic
   * collision rather than a spelling one, and a third tier answers it; see
   * `phonetic-name-search.test.ts`.
   *
   * Kept here, in the file about spelling, to record that spelling is not what solved it.
   */
  it('leaves a name that only sounds similar to the tier that can hear it', () => {
    expect(names('hawk')).toContain('hooch');
  });

  it('finds a name the recogniser split or joined', () => {
    expect(names('incrementalgeometry')).toContain('incremental-geometry');
    expect(names('incremental geometry')).toContain('incremental-geometry');
  });

  /**
   * The point is a near match, not any match. A word with nothing to do with anything on the machine
   * has to come back empty, or "did you mean" becomes noise and the assistant starts work on a
   * project nobody named.
   */
  it.each(['zzzzzz', 'telephone', 'quattro'])('finds nothing for %s', (unrelated) => {
    expect(names(unrelated)).toEqual([]);
  });

  it('puts the closest first when several are near', () => {
    expect(names('sorema')[0]).toBe('sorema-cloud');
  });
});
