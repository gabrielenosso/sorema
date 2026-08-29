import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../src/projects/project-registry.js';

let registry: ProjectRegistry;

beforeEach(() => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ct-phonetic-'));
  registry = new ProjectRegistry([workspaceRoot]);
  for (const name of ['hooch', 'incremental-geometry', 'sorema-cloud', 'xai', 'analytics-client']) {
    registry.createProject(name);
  }
});

const names = (search: string) => registry.listProjects(search).map((project) => project.name);

/**
 * The case edit distance could not reach: `hawk` for `hooch`. Four letters, three of them different,
 * and no threshold gets there without also matching projects nobody named — because the two words
 * are not close as spellings. They are close as sounds, and this is a voice product.
 *
 * Soundex answers it: both are `H200`. It is coarse, English-shaped and forty years old, and it is
 * used here only as the last thing tried, after exact and after near-spelling, so its coarseness
 * costs nothing until everything precise has already failed.
 */
describe('finding a project that only sounds like what was heard', () => {
  it.each(['hawk', 'howik', 'hoocsh'])('finds hooch from %s', (misheard) => {
    expect(names(misheard)).toContain('hooch');
  });

  it('is still not a way to match anything at all', () => {
    for (const unrelated of ['telephone', 'quattro', 'zzzzzz', 'bicycle']) {
      expect(names(unrelated)).toEqual([]);
    }
  });

  /**
   * The order the three tiers run in is the whole design. A project whose name was heard exactly
   * must never be pushed down the list by something that merely sounds like it.
   */
  it('prefers the name that actually matches over the one that sounds like it', () => {
    expect(names('hooch')).toEqual(['hooch']);
    expect(names('xai')).toEqual(['xai']);
  });

  it('does not turn one project into five', () => {
    expect(names('hawk').length).toBeLessThanOrEqual(2);
  });
});
