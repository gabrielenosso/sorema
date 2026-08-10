import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalAgentConfig } from '../../packages/config/src/index.js';
import { ProjectRegistry } from '../../apps/local-agent/src/projects/project-registry.js';
import {
  describeWorkspaceRootProblem,
  expandWorkspaceRoot,
  readWorkspaceRoots,
  suggestWorkspaceRoot,
  workspaceRootsFilePath,
  writeWorkspaceRoots,
} from '../src/workspace-roots.js';

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), 'sorema-roots-'));
}

/**
 * The whole reason this file exists: the command writes an answer, and the agent has to find it.
 *
 * Nothing is stubbed on either side. The roots go in through the command's own writer, come out
 * through the agent's real configuration parser, and are handed to the real `ProjectRegistry` — the
 * class whose empty answer is what the assistant reads out as "you have no projects". Both halves of
 * this existed and were correct; the defect was that nothing joined them, which is precisely the
 * kind of gap a test on either half alone cannot see.
 */
describe('a folder chosen with the command reaches the agent', () => {
  it('turns into the projects the agent offers', () => {
    const home = temporaryHome();
    const state = join(home, '.sorema');
    const code = join(home, 'CODE');
    mkdirSync(join(code, 'alpha'), { recursive: true });
    mkdirSync(join(code, 'beta'), { recursive: true });

    writeWorkspaceRoots(state, [code]);

    // Exactly the hand-off the command makes in applyDefaults: the file becomes the one variable the
    // agent's configuration reads. Anything else here would be a test of a rule nobody follows.
    const config = loadLocalAgentConfig({
      LOCAL_AGENT_WORKSPACE_ROOTS: readWorkspaceRoots(state).join(','),
    } as NodeJS.ProcessEnv);
    const registry = new ProjectRegistry(config.allowedWorkspaceRoots);

    const names = registry.listProjects().map((project) => project.name);

    expect(config.allowedWorkspaceRoots).toEqual([code]);
    // The registry offers the root itself as well as the folders inside it, and the order is a
    // locale comparison, so this asks what is there rather than what order it came in.
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('CODE');
  });

  it('is what the defect looked like: nothing set, nothing offered', () => {
    // The state every user was in. `LOCAL_AGENT_WORKSPACE_ROOTS` had no other setter anywhere in
    // this system, so this is not a hypothetical configuration, it is the shipped one.
    const config = loadLocalAgentConfig({} as NodeJS.ProcessEnv);
    const registry = new ProjectRegistry(config.allowedWorkspaceRoots);

    expect(config.allowedWorkspaceRoots).toEqual([]);
    expect(registry.listProjects()).toEqual([]);
  });

  it('carries more than one folder across, because the variable is a list', () => {
    const home = temporaryHome();
    const state = join(home, '.sorema');
    const work = join(home, 'work');
    const play = join(home, 'play');
    mkdirSync(join(work, 'invoices'), { recursive: true });
    mkdirSync(join(play, 'synth'), { recursive: true });

    writeWorkspaceRoots(state, [work, play]);
    const config = loadLocalAgentConfig({
      LOCAL_AGENT_WORKSPACE_ROOTS: readWorkspaceRoots(state).join(','),
    } as NodeJS.ProcessEnv);
    const names = new ProjectRegistry(config.allowedWorkspaceRoots)
      .listProjects()
      .map((project) => project.name);

    expect(names).toContain('invoices');
    expect(names).toContain('synth');
  });
});

describe('what is stored, and how badly it can go wrong', () => {
  it('reads back what it wrote', () => {
    const state = temporaryHome();
    writeWorkspaceRoots(state, ['/one', '/two']);

    expect(readWorkspaceRoots(state)).toEqual(['/one', '/two']);
  });

  it('answers with nothing rather than throwing when the file is nonsense', () => {
    const state = temporaryHome();
    writeFileSync(workspaceRootsFilePath(state), 'not json at all');

    // A daemon that will not boot because somebody edited a config file is a machine gone dark. No
    // roots is a state the agent already reports as misconfigured, which is visible in the web app.
    expect(() => readWorkspaceRoots(state)).not.toThrow();
    expect(readWorkspaceRoots(state)).toEqual([]);
  });

  it('ignores entries that are not paths', () => {
    const state = temporaryHome();
    writeFileSync(workspaceRootsFilePath(state), JSON.stringify({ roots: ['/keep', 7, null, ''] }));

    expect(readWorkspaceRoots(state)).toEqual(['/keep']);
  });

  it('answers with nothing when nobody has ever chosen', () => {
    expect(readWorkspaceRoots(temporaryHome())).toEqual([]);
  });

  it('keeps the file to its owner, like the identity beside it', () => {
    const state = temporaryHome();
    writeWorkspaceRoots(state, ['/one']);

    // It is not a secret, but it decides which folders a coding agent may edit, so another account
    // on the machine must not be able to widen it.
    expect(readFileSync(workspaceRootsFilePath(state), 'utf8')).toContain('/one');
  });
});

describe('reading what somebody typed', () => {
  it('expands the tilde people actually type', () => {
    const home = temporaryHome();

    // Left alone this resolves to a folder literally named "~" under the current directory, so the
    // answer would be refused for existing nowhere rather than for being wrong.
    expect(expandWorkspaceRoot('~/CODE', home)).toBe(join(home, 'CODE'));
    expect(expandWorkspaceRoot('~', home)).toBe(home);
  });

  it('strips the quotes Windows puts around a copied path', () => {
    const home = temporaryHome();
    const code = join(home, 'CODE');
    mkdirSync(code);

    expect(expandWorkspaceRoot(`"${code}"`, home)).toBe(code);
  });

  it('refuses a folder that is not there', () => {
    expect(describeWorkspaceRootProblem(join(temporaryHome(), 'nope'))).toMatch(/no folder/);
  });

  it('refuses a file', () => {
    const home = temporaryHome();
    const file = join(home, 'notes.txt');
    writeFileSync(file, 'x');

    expect(describeWorkspaceRootProblem(file)).toMatch(/not a folder/);
  });

  it('refuses a whole drive', () => {
    // The one wrong answer with no way back: it hands every file on the machine to the coding
    // agents, and nobody notices until one of them edits something that was never theirs.
    const root = process.platform === 'win32' ? 'C:\\' : '/';

    expect(describeWorkspaceRootProblem(root)).toMatch(/whole drive/);
  });

  it('accepts a folder that is there', () => {
    const home = temporaryHome();
    const code = join(home, 'CODE');
    mkdirSync(code);

    expect(describeWorkspaceRootProblem(code)).toBeNull();
  });
});

describe('what it offers before anyone has typed anything', () => {
  it('suggests a conventional folder when one exists', () => {
    const home = temporaryHome();
    mkdirSync(join(home, 'Projects'));

    expect(suggestWorkspaceRoot(home)).toBe(join(home, 'Projects'));
  });

  it('suggests nothing rather than the home directory', () => {
    const home = temporaryHome();

    // A suggestion is what most people will accept, so a wrong one becomes the answer. The home
    // directory would put Documents, Downloads and the browser profile inside what agents may edit.
    expect(suggestWorkspaceRoot(home)).toBeNull();
  });

  it('never suggests a path that would then be refused', () => {
    const home = temporaryHome();
    mkdirSync(join(home, 'code'));
    const suggestion = suggestWorkspaceRoot(home);

    expect(suggestion).not.toBeNull();
    expect(describeWorkspaceRootProblem(String(suggestion))).toBeNull();
  });
});
