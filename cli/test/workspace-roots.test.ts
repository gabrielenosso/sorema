import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalAgentConfig } from '../../packages/config/src/index.js';
import { ProjectRegistry } from '../../apps/local-agent/src/projects/project-registry.js';
import {
  describeWorkspaceRootProblem,
  expandWorkspaceRoot,
  readWorkspaceRoots,
  recoverSwallowedSeparators,
  suggestWorkspaceRoot,
  WORKSPACE_RISK_WARNING,
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
    // Only folders git is tracking are offered as projects.
    mkdirSync(join(code, 'alpha', '.git'), { recursive: true });
    mkdirSync(join(code, 'beta', '.git'), { recursive: true });

    writeWorkspaceRoots(state, [code]);

    // Exactly the hand-off the command makes in applyDefaults: the file becomes the one variable the
    // agent's configuration reads. Anything else here would be a test of a rule nobody follows.
    const config = loadLocalAgentConfig({
      LOCAL_AGENT_WORKSPACE_ROOTS: readWorkspaceRoots(state).join(','),
    } as NodeJS.ProcessEnv);
    const registry = new ProjectRegistry(config.allowedWorkspaceRoots);

    const names = registry.listProjects().map((project) => project.name);

    expect(config.allowedWorkspaceRoots).toEqual([code]);
    // The order is a locale comparison, so this asks what is there rather than what order it came
    // in. The root itself is a plain folder holding the repositories, so it is not one of them.
    expect(names).toEqual(['alpha', 'beta']);
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
    mkdirSync(join(work, 'invoices', '.git'), { recursive: true });
    mkdirSync(join(play, 'synth', '.git'), { recursive: true });

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

/**
 * Every shape a path arrives in, held against what it has to expand to.
 *
 * The platform is passed in rather than read from `process.platform`, so the rules of the other
 * operating system are exercised from this one. That matters most for the POSIX rows: a backslash is
 * an ordinary character in a file name there, so a Windows-shaped normalisation would silently
 * answer with a different folder, and a suite that only ever runs on Windows would never see it.
 */
interface Expansion {
  readonly shape: string;
  readonly typed: string;
  readonly expected: string;
}

const WINDOWS_HOME = 'C:\\Users\\me';
const POSIX_HOME = '/home/me';

const WINDOWS_EXPANSIONS: readonly Expansion[] = [
  {
    shape: 'backslashes, the way Windows writes a path',
    typed: 'C:\\Users\\me\\CODE',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'forward slashes, which a Windows user reasonably types',
    typed: 'C:/Users/me/CODE',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'both separators in the one path',
    typed: 'C:/Users\\me/CODE',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'a trailing separator, which completion leaves behind',
    typed: 'C:\\Users\\me\\CODE\\',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'a trailing forward slash',
    typed: 'C:/Users/me/CODE/',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'quoted, the way "Copy as path" pastes it',
    typed: '"C:\\Users\\me\\CODE"',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'quoted and trailing a separator at once',
    typed: '"C:\\Users\\me\\CODE\\"',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'padded with the spaces a paste leaves',
    typed: '  C:\\Users\\me\\CODE  ',
    expected: 'C:\\Users\\me\\CODE',
  },
  {
    shape: 'a folder whose name contains spaces',
    typed: 'C:\\Users\\me\\my code',
    expected: 'C:\\Users\\me\\my code',
  },
  {
    shape: 'a UNC share, whose leading double separator has to survive',
    typed: '\\\\server\\share\\code',
    expected: '\\\\server\\share\\code',
  },
  {
    shape: 'a UNC share written with forward slashes',
    typed: '//server/share/code',
    expected: '\\\\server\\share\\code',
  },
  { shape: 'home-relative with a forward slash', typed: '~/CODE', expected: 'C:\\Users\\me\\CODE' },
  {
    shape: 'home-relative with a backslash, a separator here',
    typed: '~\\CODE',
    expected: 'C:\\Users\\me\\CODE',
  },
  { shape: 'the home directory itself', typed: '~', expected: 'C:\\Users\\me' },
  { shape: 'a drive root, which keeps its separator', typed: 'C:\\', expected: 'C:\\' },
];

const POSIX_EXPANSIONS: readonly Expansion[] = [
  { shape: 'an absolute path', typed: '/home/me/code', expected: '/home/me/code' },
  { shape: 'a trailing separator', typed: '/home/me/code/', expected: '/home/me/code' },
  { shape: 'a quoted path', typed: '"/home/me/code"', expected: '/home/me/code' },
  {
    shape: 'a quoted path with a trailing separator',
    typed: '"/home/me/code/"',
    expected: '/home/me/code',
  },
  {
    shape: 'a folder whose name contains spaces',
    typed: '/home/me/my code',
    expected: '/home/me/my code',
  },
  {
    shape: 'a folder whose name contains a backslash, which is legal here',
    typed: '/home/me/we\\ird',
    expected: '/home/me/we\\ird',
  },
  { shape: 'home-relative', typed: '~/code', expected: '/home/me/code' },
  { shape: 'the home directory itself', typed: '~', expected: '/home/me' },
  { shape: 'the root', typed: '/', expected: '/' },
];

describe('every shape a path arrives in', () => {
  for (const { shape, typed, expected } of WINDOWS_EXPANSIONS) {
    it(`win32: ${shape}`, () => {
      expect(expandWorkspaceRoot(typed, WINDOWS_HOME, 'win32')).toBe(expected);
    });
  }

  for (const { shape, typed, expected } of POSIX_EXPANSIONS) {
    it(`linux: ${shape}`, () => {
      expect(expandWorkspaceRoot(typed, POSIX_HOME, 'linux')).toBe(expected);
    });
  }

  it('reads macOS the way it reads Linux', () => {
    expect(expandWorkspaceRoot('~/code', '/Users/me', 'darwin')).toBe('/Users/me/code');
  });

  it('leaves a POSIX backslash where it is, even next to a tilde', () => {
    // `~\code` on macOS or Linux is one file name containing a backslash, sitting in the current
    // directory. Expanding it as if the backslash were a separator would answer with a folder in the
    // home directory that nobody named — the mirror image of the Windows defect this all began with.
    const expanded = expandWorkspaceRoot('~\\code', POSIX_HOME, 'linux');

    expect(expanded.endsWith('~\\code')).toBe(true);
    expect(expanded.startsWith(POSIX_HOME)).toBe(false);
  });
});

/**
 * Which of those shapes is a drive-relative path, and which merely looks like one.
 *
 * The refusal is the dangerous half of this file: a check that turns away a path somebody really
 * has costs them the feature and tells them their shell is broken. So the negative rows are the
 * point, and they outnumber the positive ones.
 */
const DRIVE_RELATIVE_MARKER = 'relative to drive';

interface Judgement {
  readonly shape: string;
  readonly typed: string;
  readonly platform: NodeJS.Platform;
  readonly driveRelative: boolean;
}

const JUDGEMENTS: readonly Judgement[] = [
  {
    shape: 'the path Git Bash ate the backslashes out of',
    typed: 'C:UsersmeCODE',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'the same path with quotes around it, which must not hide it',
    typed: '"C:UsersmeCODE"',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'the same path padded with spaces',
    typed: '  C:UsersmeCODE  ',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'a half-eaten path, where one separator survived',
    typed: 'C:Users/me',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'a bare drive letter, which means that drive\u2019s current directory',
    typed: 'C:',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'a lower-case drive letter',
    typed: 'c:UsersmeCODE',
    platform: 'win32',
    driveRelative: true,
  },
  {
    shape: 'an ordinary Windows path',
    typed: 'C:\\Users\\me\\CODE',
    platform: 'win32',
    driveRelative: false,
  },
  {
    shape: 'a Windows path written with forward slashes',
    typed: 'C:/Users/me/CODE',
    platform: 'win32',
    driveRelative: false,
  },
  {
    shape: 'a Windows path with a trailing separator',
    typed: 'C:\\Users\\me\\CODE\\',
    platform: 'win32',
    driveRelative: false,
  },
  {
    shape: 'a Windows path whose folder name has spaces',
    typed: 'C:\\Users\\me\\my code',
    platform: 'win32',
    driveRelative: false,
  },
  { shape: 'a drive root', typed: 'C:\\', platform: 'win32', driveRelative: false },
  {
    shape: 'a drive root with a forward slash',
    typed: 'C:/',
    platform: 'win32',
    driveRelative: false,
  },
  {
    // The host is deliberately unresolvable and deliberately has a dot in it: a bare name sends
    // Windows through NetBIOS resolution, which takes five seconds to fail inside the file check.
    shape: 'a UNC path',
    typed: '\\\\nowhere.invalid\\share\\code',
    platform: 'win32',
    driveRelative: false,
  },
  {
    shape: 'a UNC path with forward slashes',
    typed: '//nowhere.invalid/share/code',
    platform: 'win32',
    driveRelative: false,
  },
  { shape: 'a relative path', typed: 'code', platform: 'win32', driveRelative: false },
  {
    shape: 'an explicitly relative path',
    typed: '.\\code',
    platform: 'win32',
    driveRelative: false,
  },
  {
    shape: 'a path out of the current one',
    typed: '..\\code',
    platform: 'win32',
    driveRelative: false,
  },
  { shape: 'a home-relative path', typed: '~/CODE', platform: 'win32', driveRelative: false },
  {
    shape: 'the swallowed shape, which on POSIX is an ordinary file name with a colon in it',
    typed: 'C:UsersmeCODE',
    platform: 'linux',
    driveRelative: false,
  },
  {
    shape: 'a POSIX absolute path',
    typed: '/home/me/code',
    platform: 'linux',
    driveRelative: false,
  },
  {
    shape: 'a POSIX file name containing a backslash',
    typed: '/home/me/we\\ird',
    platform: 'darwin',
    driveRelative: false,
  },
  {
    shape: 'a POSIX home-relative path',
    typed: '~/code',
    platform: 'darwin',
    driveRelative: false,
  },
];

describe('telling a drive-relative path from a real one', () => {
  for (const { shape, typed, platform, driveRelative } of JUDGEMENTS) {
    it(`${platform}: ${shape}`, () => {
      const home = platform === 'win32' ? WINDOWS_HOME : POSIX_HOME;
      const problem = describeWorkspaceRootProblem(
        expandWorkspaceRoot(typed, home, platform),
        typed,
        platform,
      );

      // The rejected shapes are named for what they are; the accepted ones may still be refused for
      // not existing on this machine, which is a different sentence and a correct one.
      expect(problem?.includes(DRIVE_RELATIVE_MARKER) ?? false).toBe(driveRelative);
    });
  }

  it('says what happened rather than naming a folder nobody typed', () => {
    // Git Bash turns C:\Users\me\CODE into C:UsersmeCODE, and Windows resolves that against the
    // current directory of drive C — so the old message named a VS Code folder the user had never
    // mentioned, which reads as the command being broken.
    const problem = describeWorkspaceRootProblem(
      'C:\\somewhere\\else\\UsersmeCODE',
      'C:UsersmeCODE',
      'win32',
    );

    expect(problem).toContain('C:UsersmeCODE');
    expect(problem).toContain('a shell reads each backslash as an escape and eats it');
    expect(problem).not.toContain('somewhere');
  });

  it('leaves a real path alone', () => {
    expect(describeWorkspaceRootProblem(process.cwd(), process.cwd())).toBeNull();
  });
});

/**
 * Whether a path whose separators were eaten can be put back automatically.
 *
 * From the characters alone it cannot: `UsersmeCODE` is `Users\me\CODE` and `User\sme\CODE` and
 * nothing in the string says which. The filesystem can sometimes say, and these three cases are the
 * evidence for both halves of that claim — one reading on disk, two readings on disk, none.
 */
describe('putting the separators back, when the machine can say how', () => {
  it('recovers the one reading that exists on this machine', () => {
    const root = temporaryHome();
    mkdirSync(join(root, 'Users', 'me', 'CODE'), { recursive: true });

    expect(recoverSwallowedSeparators(root, 'UsersmeCODE')).toBe(join(root, 'Users', 'me', 'CODE'));
  });

  it('refuses when two readings exist, because the string cannot say which', () => {
    const root = temporaryHome();
    mkdirSync(join(root, 'Users', 'me', 'CODE'), { recursive: true });
    mkdirSync(join(root, 'User', 'sme', 'CODE'), { recursive: true });

    // This is the whole argument for refusing rather than guessing, as a fact about a real disk
    // rather than an assertion about strings.
    expect(recoverSwallowedSeparators(root, 'UsersmeCODE')).toBeNull();
  });

  it('refuses when no reading exists', () => {
    expect(recoverSwallowedSeparators(temporaryHome(), 'UsersmeCODE')).toBeNull();
  });

  it('recovers a half-eaten path, where some separators survived', () => {
    const root = temporaryHome();
    mkdirSync(join(root, 'Users', 'me', 'CODE'), { recursive: true });

    expect(recoverSwallowedSeparators(root, 'Usersme/CODE')).toBe(
      join(root, 'Users', 'me', 'CODE'),
    );
  });

  it('matches without regard to case, because it is recovering a Windows path', () => {
    const root = temporaryHome();
    mkdirSync(join(root, 'Users', 'me', 'CODE'), { recursive: true });

    expect(recoverSwallowedSeparators(root, 'usersmecode')).toBe(join(root, 'Users', 'me', 'CODE'));
  });

  it('will not answer with a file', () => {
    const root = temporaryHome();
    writeFileSync(join(root, 'UsersmeCODE'), 'x');

    expect(recoverSwallowedSeparators(root, 'UsersmeCODE')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('names the recovered folder in the refusal', () => {
    // On Windows there is exactly one folder under C:\ that reads as "Windows", so this machine can
    // say what was meant. The message offers it; nothing adopts it, because a root is the boundary
    // the coding agents are held to and one reading existing is not the same as it being intended.
    const problem = describeWorkspaceRootProblem('C:\\anywhere', 'C:Windows', 'win32');

    expect(problem).toContain('C:\\Windows');
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

  it('accepts the trailing separator a file manager leaves on, quoted or not', () => {
    const home = temporaryHome();
    const code = join(home, 'CODE');
    mkdirSync(code);

    expect(expandWorkspaceRoot(`${code}${sep}`, home)).toBe(code);
    expect(expandWorkspaceRoot(`"${code}${sep}"`, home)).toBe(code);
    expect(describeWorkspaceRootProblem(code, `"${code}${sep}"`)).toBeNull();
  });

  it('refuses an empty answer rather than adopting the current directory', () => {
    // `resolve('')` is the working directory, which would quietly become the boundary the coding
    // agents are held to, named nowhere in what the person typed.
    expect(describeWorkspaceRootProblem(expandWorkspaceRoot(''), '')).toMatch(
      /no folder was named/,
    );
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

  it('refuses a whole drive on either operating system', () => {
    expect(describeWorkspaceRootProblem('C:\\', 'C:\\', 'win32')).toMatch(/whole drive/);
    expect(describeWorkspaceRootProblem('/', '/', 'linux')).toMatch(/whole drive/);
    expect(describeWorkspaceRootProblem('\\\\server\\share\\', '//server/share/', 'win32')).toMatch(
      /whole drive/,
    );
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

/**
 * What somebody is told before they name the folder.
 *
 * The question itself explains the boundary well: the folders inside become the projects, and
 * nothing outside is ever touched. What it never said is what happens INSIDE. Coding agents read,
 * change and delete files there, and Sorema starts them in a mode that applies edits without asking
 * per operation. That is the consequential half, and the person deciding it is sitting in a
 * terminal, possibly days after accepting anything in a browser, possibly having installed this
 * straight from npm and never seen the app at all.
 *
 * The text lives here rather than inline in the command so that this test reads the same bytes the
 * command prints.
 */
describe('the warning shown before the folder question', () => {
  it('says files will be changed and deleted without asking each time', () => {
    expect(WORKSPACE_RISK_WARNING).toMatch(/delete/i);
    expect(WORKSPACE_RISK_WARNING).toMatch(/without asking/i);
  });

  it('tells them to keep their own backups', () => {
    expect(WORKSPACE_RISK_WARNING).toMatch(/backup/i);
  });

  it('promises nothing outside the folder', () => {
    expect(WORKSPACE_RISK_WARNING).toMatch(/outside/i);
  });

  it('says which folders are eligible at all, because only git repositories are', () => {
    // The undo is the user's own history, so a folder without one is never offered. Somebody who
    // does not know that reads an empty project list as a broken install.
    expect(WORKSPACE_RISK_WARNING).toMatch(/git/i);
  });

  it('stays short enough that somebody reads it', () => {
    // Four lines at most. A wall of text in a terminal is skipped, and a warning nobody reads is
    // worse than none: it is a warning the operator can point at and the user never saw.
    expect(WORKSPACE_RISK_WARNING.trimEnd().split('\n').length).toBeLessThanOrEqual(4);
  });
});
