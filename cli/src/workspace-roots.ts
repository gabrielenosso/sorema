import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Which folders this machine offers as projects.
 *
 * The agent has always read this from `LOCAL_AGENT_WORKSPACE_ROOTS`, and nothing ever set it —
 * not the command, not the web app, not pairing. So every machine that had been through the whole
 * of the setup still listed no projects, and the assistant answered, truthfully from where it sat,
 * that there were none. Asking once and writing the answer down here is what closes that.
 *
 * It lives beside the device identity rather than in the environment because the answer is needed
 * by `sorema start` running under a service, which inherits no shell and has nobody to ask.
 */
export const WORKSPACE_ROOTS_FILE_NAME = 'workspace-roots.json';

/**
 * Where people actually keep code, in the order worth offering.
 *
 * A blank prompt gets a wrong answer or no answer; a suggestion that is right most of the time gets
 * a return keypress. None of these is the home directory, which is deliberate — see below.
 */
const CONVENTIONAL_CODE_DIRECTORIES = [
  'CODE',
  'code',
  'Projects',
  'projects',
  'Developer',
  'dev',
  'src',
  'repos',
  'git',
  'workspace',
  join('Documents', 'GitHub'),
];

export function workspaceRootsFilePath(stateDirectory: string): string {
  return join(stateDirectory, WORKSPACE_ROOTS_FILE_NAME);
}

/**
 * Never throws. A daemon that will not start because this file was hand-edited into nonsense is
 * worse than one that starts with no roots: the second reports itself misconfigured, which is
 * visible in the web app, while the first is just a machine that went dark.
 */
export function readWorkspaceRoots(stateDirectory: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(workspaceRootsFilePath(stateDirectory), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return [];
    const roots = (parsed as { roots?: unknown }).roots;
    if (!Array.isArray(roots)) return [];
    return roots.filter((root): root is string => typeof root === 'string' && root.length > 0);
  } catch {
    return [];
  }
}

export function writeWorkspaceRoots(stateDirectory: string, roots: readonly string[]): void {
  mkdirSync(stateDirectory, { recursive: true });
  // Owner-only, like the identity beside it. This is not a secret, but it decides which directories
  // a coding agent may edit, so another account on the machine must not be able to widen it.
  writeFileSync(
    workspaceRootsFilePath(stateDirectory),
    `${JSON.stringify({ roots: [...roots] }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export function expandWorkspaceRoot(candidate: string, home: string = homedir()): string {
  // Windows "Copy as path" hands over a quoted path, and the quotes are part of what gets pasted.
  const trimmed = candidate.trim().replace(/^"(.*)"$/, '$1');
  // `~` is what people type and is not a folder: left alone it resolves to a directory named "~"
  // under the current one, which exists nowhere, so the answer would be refused for the wrong reason.
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(home, trimmed.slice(1))
      : trimmed;
  return resolve(expanded);
}

/**
 * Whether a shell ate the backslashes on the way here.
 *
 * `sorema projects C:\Users\me\CODE` in Git Bash arrives as `C:UsersmeCODE`, because the shell
 * reads each backslash as an escape. Windows then resolves that against the current directory of
 * drive C rather than its root, so it lands somewhere the user has never heard of — and the message
 * they get names a folder they did not type, which reads as the command being broken rather than
 * the shell having rewritten their argument.
 */
function looksLikeSwallowedSeparators(typed: string): boolean {
  const BACKSLASH = String.fromCharCode(92);
  if (typed.includes('/') || typed.includes(BACKSLASH)) return false;
  return /^[A-Za-z]:./.test(typed);
}

/** Null when the folder can be used. A sentence naming the problem when it cannot. */
export function describeWorkspaceRootProblem(
  absolutePath: string,
  typed: string = absolutePath,
): string | null {
  if (looksLikeSwallowedSeparators(typed)) {
    return (
      `${typed} has no separators in it, so your shell probably ate the backslashes. ` +
      'Write it with forward slashes instead, like C:/Users/you/CODE'
    );
  }
  // The root of a drive is every file on the machine, which is never what somebody means by "where
  // my code lives" and is the one wrong answer nobody notices until an agent edits something else.
  if (dirname(absolutePath) === absolutePath) return `${absolutePath} is a whole drive`;
  try {
    if (!statSync(absolutePath).isDirectory()) return `${absolutePath} is a file, not a folder`;
  } catch {
    return existsSync(absolutePath)
      ? `${absolutePath} cannot be read`
      : `there is no folder at ${absolutePath}`;
  }
  return null;
}

export function suggestWorkspaceRoot(home: string = homedir()): string | null {
  for (const relativePath of CONVENTIONAL_CODE_DIRECTORIES) {
    const candidate = join(home, relativePath);
    if (describeWorkspaceRootProblem(candidate) === null) return candidate;
  }
  // Deliberately not the home directory as a fallback. A suggestion is what most people will accept,
  // so a wrong one becomes the answer — and the home directory would put Documents, Downloads and
  // the browser profile inside what the coding agents are allowed to change.
  return null;
}
