import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

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

const WINDOWS_SEPARATOR = '\\';

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

/**
 * The path rules of one operating system, chosen explicitly.
 *
 * Windows understands both separators and macOS and Linux understand one, and the difference is not
 * cosmetic: a backslash is an ordinary character in a POSIX file name, so a rule written for Windows
 * renames somebody's folder if it is allowed to run there. Passing the platform in rather than
 * reading `process.platform` inside is also the only way the other system's behaviour can be tested
 * from this one.
 */
function pathRules(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

/** Windows "Copy as path" hands over a quoted path, and the quotes are part of what gets pasted. */
function unquoted(value: string): string {
  return value.replace(/^"(.*)"$/s, '$1');
}

/**
 * Both separators, written the way this platform writes them.
 *
 * A Windows user reasonably types `C:/Users/me/CODE`, a copied path arrives with backslashes, and a
 * path that has been through a config file or a web form can hold both. On macOS and Linux there is
 * nothing to normalise: `/home/me/we\ird` is a folder whose name contains a backslash, and rewriting
 * it would point at a different folder or at none.
 */
function toPlatformSeparators(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.split('/').join(WINDOWS_SEPARATOR) : value;
}

export function expandWorkspaceRoot(
  candidate: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathRules(platform);
  const written = toPlatformSeparators(unquoted(candidate.trim()), platform);
  // `~` is what people type and is not a folder: left alone it resolves to a directory named "~"
  // under the current one, which exists nowhere, so the answer would be refused for the wrong reason.
  // `~\code` counts only on Windows, where the backslash is a separator rather than a file name.
  const isHomeRelative = written === '~' || written.startsWith(`~${paths.sep}`);
  const expanded = isHomeRelative ? paths.join(home, written.slice(1)) : written;
  // A trailing separator is what a file manager and a shell's completion both produce, and resolve
  // drops it — so `C:/Users/me/CODE/` and `C:/Users/me/CODE` are the same answer.
  return paths.resolve(expanded);
}

/** How many directories the recovery below may read before it gives up rather than guessing. */
const RECOVERY_DIRECTORY_READS = 64;

/**
 * The one case where a path whose separators were eaten can be put back: exactly one reading of it
 * exists on this machine.
 *
 * `UsersmeCODE` cannot be split back by looking at it — `Users\me\CODE` and `User\sme\CODE` are
 * equally consistent with the characters, and the information that told them apart is gone. The
 * filesystem is the only thing that can still tell them apart, and only sometimes: this walks the
 * tree consuming the string, and answers only when the walk finished and found precisely one folder.
 * Two readings, none, or a walk that had to be cut short all answer null, because a guess here
 * decides which directories a coding agent may edit.
 *
 * Matching is case-insensitive because this recovers a Windows path, and separators already present
 * in the remainder are honoured as boundaries, so a half-eaten `Users/me` recovers as well.
 */
export function recoverSwallowedSeparators(
  startDirectory: string,
  remainder: string,
): string | null {
  const found: string[] = [];
  let directoryReadsLeft = RECOVERY_DIRECTORY_READS;
  let searchWasCutShort = false;

  const walk = (directory: string, rest: string): void => {
    if (found.length > 1 || searchWasCutShort) return;
    if (rest.length === 0) {
      found.push(directory);
      return;
    }
    const head = rest.slice(0, 1);
    if (head === '/' || head === WINDOWS_SEPARATOR) {
      walk(directory, rest.slice(1));
      return;
    }
    if (directoryReadsLeft === 0) {
      searchWasCutShort = true;
      return;
    }
    directoryReadsLeft -= 1;
    let entries: readonly string[];
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // An unreadable directory is a branch that cannot be ruled in or out, so it is not a candidate
      // and it is not a reason to stop looking down the ones that can be read.
      return;
    }
    for (const name of entries) {
      if (!rest.toLowerCase().startsWith(name.toLowerCase())) continue;
      walk(join(directory, name), rest.slice(name.length));
    }
  };

  walk(startDirectory, remainder);
  if (searchWasCutShort || found.length !== 1) return null;
  return found[0] ?? null;
}

/**
 * A drive letter with no separator after it, which is never what somebody means.
 *
 * `sorema projects C:\Users\me\CODE` in Git Bash arrives as `C:UsersmeCODE`, because the shell reads
 * each backslash as an escape and eats it. Windows then resolves that against the current directory
 * *of drive C* rather than its root, so it lands somewhere the user has never heard of — and the
 * message they get names a folder they did not type, which reads as the command being broken rather
 * than the shell having rewritten their argument.
 *
 * Every drive-relative path is refused, not only the ones with no separators left, because where it
 * ends up depends on per-drive state nobody can see. On macOS and Linux this never fires: `C:code`
 * there is an ordinary relative path with a colon in its name.
 */
const DRIVE_RELATIVE_PATH = /^([A-Za-z]):(?![\\/])(.*)$/s;

function describeDriveRelativePath(written: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return null;
  const match = DRIVE_RELATIVE_PATH.exec(written);
  if (!match) return null;
  const driveLetter = match[1] ?? '';
  const remainder = match[2] ?? '';
  const recovered =
    remainder.length > 0
      ? recoverSwallowedSeparators(`${driveLetter}:${WINDOWS_SEPARATOR}`, remainder)
      : null;
  const advice = recovered
    ? `The only folder on this machine it can mean is ${recovered}, so try that`
    : `Write it with forward slashes instead, like ${driveLetter}:/Users/you/CODE`;
  return (
    `${written} is relative to drive ${driveLetter}'s current directory rather than ` +
    `${driveLetter}:${WINDOWS_SEPARATOR}, because there is no separator after the colon — ` +
    `a shell reads each backslash as an escape and eats it. ${advice}`
  );
}

/** Null when the folder can be used. A sentence naming the problem when it cannot. */
export function describeWorkspaceRootProblem(
  absolutePath: string,
  typed: string = absolutePath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const written = toPlatformSeparators(unquoted(typed.trim()), platform);
  // Resolving nothing answers the current directory, which would quietly become the boundary the
  // coding agents are held to — and whoever typed it would never see the word they did not type.
  if (written.length === 0) return 'no folder was named';
  const driveRelative = describeDriveRelativePath(written, platform);
  if (driveRelative) return driveRelative;
  // The root of a drive is every file on the machine, which is never what somebody means by "where
  // my code lives" and is the one wrong answer nobody notices until an agent edits something else.
  const paths = pathRules(platform);
  if (paths.dirname(absolutePath) === absolutePath) return `${absolutePath} is a whole drive`;
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
