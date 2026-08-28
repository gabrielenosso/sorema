import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SoremaError, type ProjectSummary } from '@sorema/domain-model';
import { normalizeWorkspaceRoots, resolveWithinAllowedRoots } from '@sorema/security';

const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  '.next',
  '.venv',
  '__pycache__',
]);

export function createProjectIdentifier(canonicalPath: string): string {
  return `proj_${createHash('sha256').update(canonicalPath.toLowerCase()).digest('hex').slice(0, 16)}`;
}

export class ProjectRegistry {
  private readonly allowedRoots: string[];

  constructor(allowedRoots: readonly string[]) {
    this.allowedRoots = normalizeWorkspaceRoots(allowedRoots.filter((root) => existsSync(root)));
  }

  get roots(): readonly string[] {
    return this.allowedRoots;
  }

  listProjects(search?: string): ProjectSummary[] {
    const projects = new Map<string, ProjectSummary>();
    for (const root of this.allowedRoots) {
      for (const candidate of [root, ...this.readChildDirectories(root)]) {
        const summary = this.describeProject(candidate);
        // A folder git is not tracking is not offered at all. Everything a coding agent does here
        // is undone by going back through the user's own history, and a folder with no history has
        // no undo: a deletion in one is simply gone.
        if (summary?.isGitRepository) projects.set(summary.id, summary);
      }
    }
    const all = [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
    if (!search || search.trim().length === 0) return all;
    const needle = search.trim().toLowerCase();
    const spokenNeedle = normalizeSpokenProjectName(search);
    const matched = all.filter((project) => {
      const name = project.name.toLowerCase();
      return (
        name.includes(needle) ||
        (spokenNeedle.length > 0 && normalizeSpokenProjectName(name).includes(spokenNeedle))
      );
    });
    if (matched.length > 0 || spokenNeedle.length === 0) return matched;

    /**
     * Nothing matched exactly, so answer the question that was actually asked.
     *
     * A microphone that cannot carry a project name is the ordinary case here, not the exception. One
     * recorded conversation went: the user says a name, the assistant hears `hawk` and finds nothing,
     * hears `hoch` and finds nothing, hears `hoch with two o` and finds nothing. The project was
     * `hooch`, on that machine, the whole time. "No" was true three times and useless three times:
     * nobody is asking whether their spelling exists.
     *
     * Near, not any. A word with nothing to do with anything here still comes back empty, because a
     * loose match is how an agent gets started on a project nobody named.
     */
    return all
      .map((project) => ({
        project,
        distance: editDistance(spokenNeedle, normalizeSpokenProjectName(project.name)),
      }))
      .filter(({ project, distance }) => distance <= nearEnough(project.name, spokenNeedle))
      .sort((left, right) => left.distance - right.distance)
      .map(({ project }) => project);
  }

  private readChildDirectories(root: string): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name))
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  }

  private describeProject(candidatePath: string): ProjectSummary | null {
    try {
      const stats = statSync(candidatePath);
      if (!stats.isDirectory()) return null;
      return {
        id: createProjectIdentifier(candidatePath),
        name: basename(candidatePath),
        path: candidatePath,
        isGitRepository: existsSync(join(candidatePath, '.git')),
        lastModifiedAt: stats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  resolveProjectPath(projectId: string): string {
    const match = this.listProjects().find((project) => project.id === projectId);
    if (!match) {
      throw SoremaError.of('PROJECT_NOT_FOUND', `No project with id ${projectId}`, {
        details: { projectId },
      });
    }
    return resolveWithinAllowedRoots(match.path, this.allowedRoots);
  }

  assertPathIsAllowed(candidatePath: string): string {
    return resolveWithinAllowedRoots(candidatePath, this.allowedRoots);
  }

  createProject(name: string, workspaceRootPath?: string): ProjectSummary {
    const folderName = sanitizeProjectFolderName(name);
    const root = workspaceRootPath
      ? resolveWithinAllowedRoots(workspaceRootPath, this.allowedRoots)
      : this.allowedRoots[0];

    if (!root) {
      throw SoremaError.of('PROJECT_NOT_ALLOWED', 'No workspace root is configured on this device');
    }

    // join() first, then re-check against the roots: a name like ".." would otherwise escape the
    // workspace even though the root itself is allowed.
    const targetPath = resolveWithinAllowedRoots(join(root, folderName), this.allowedRoots);

    if (existsSync(targetPath)) {
      const existing = this.describeProject(targetPath);
      if (existing?.isGitRepository) return existing;
      if (existing) {
        // Not ours to convert. Turning somebody's existing folder into a repository would commit
        // whatever is already in it, under this name, without them asking.
        throw SoremaError.of(
          'PROJECT_NOT_ALLOWED',
          `${targetPath} already exists and git is not tracking it`,
          {
            userMessage:
              'There is already a folder with that name, and it is not a git repository. ' +
              'Pick another name, or set that one up in git yourself first.',
          },
        );
      }
      throw SoremaError.of(
        'PROJECT_NOT_ALLOWED',
        `A file already exists at ${targetPath} and is not a folder`,
        { userMessage: 'Something with that name already exists there and is not a folder.' },
      );
    }

    mkdirSync(targetPath, { recursive: true });
    try {
      initialiseRepository(targetPath);
    } catch (error) {
      // A half-made project is worse than none: it would be invisible to `listProjects` and would
      // block the name for every later attempt.
      rmSync(targetPath, { recursive: true, force: true });
      throw error;
    }

    const created = this.describeProject(targetPath);
    if (!created) {
      throw SoremaError.of('INTERNAL_ERROR', `Could not describe the new project at ${targetPath}`);
    }
    return created;
  }
}

/**
 * A repository and a first commit, because `git init` on its own is not an undo.
 *
 * Everything in a freshly initialised repository is untracked, and untracked files are exactly the
 * ones git cannot bring back. One empty commit is what makes `git reset --hard` mean something on
 * the day a coding agent deletes the wrong file.
 */
function initialiseRepository(folderPath: string): void {
  const run = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: folderPath, stdio: 'ignore', windowsHide: true });
  };

  try {
    run(['init']);
  } catch {
    throw SoremaError.of('PROJECT_NOT_ALLOWED', `git is not available to initialise ${folderPath}`, {
      userMessage:
        'I could not start a git repository for that project, because git is not installed on ' +
        'this machine. Install it and ask me again.',
    });
  }

  const firstCommit = ['commit', '--allow-empty', '-m', 'start'];
  try {
    run(firstCommit);
  } catch {
    // A machine with no git identity configured cannot commit at all. The name on this one commit
    // is of no consequence, and refusing over it would be refusing the whole feature.
    run(['-c', 'user.name=Sorema', '-c', 'user.email=sorema@localhost', ...firstCommit]);
  }
}

/** Treat punctuation the recognizer may insert into a spoken name as presentation, not identity. */
function normalizeSpokenProjectName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function sanitizeProjectFolderName(rawName: string): string {
  const folderName = rawName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/^[-._]+|[-._]+$/g, '');

  if (folderName.length === 0 || RESERVED_WINDOWS_NAMES.has(folderName)) {
    throw SoremaError.of('PROJECT_NOT_ALLOWED', `"${rawName}" cannot be used as a folder name`, {
      userMessage: 'That name cannot be used for a folder. Can you suggest another one?',
    });
  }
  return folderName;
}

/**
 * How wrong a heard name may be and still mean this project.
 *
 * Proportional to length, because two wrong letters in `xai` is a different word and two wrong
 * letters in `incremental-geometry` is a microphone. Capped, so that a very long name does not start
 * matching everything, and floored at one so that a single slip always survives.
 */
function nearEnough(name: string, heard: string): number {
  const longest = Math.max(normalizeSpokenProjectName(name).length, heard.length);
  return Math.max(1, Math.min(4, Math.floor(longest / 2)));
}

/** Levenshtein, iterative over two rows: names are short and this runs once per project per search. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (previous[column] as number) + 1,
        (current[column - 1] as number) + 1,
        (previous[column - 1] as number) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] as number;
}
