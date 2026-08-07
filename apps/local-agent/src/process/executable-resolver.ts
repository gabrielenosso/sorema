import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

function isExecutableFile(candidatePath: string): boolean {
  try {
    if (!statSync(candidatePath).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(candidatePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter((extension) => extension.length > 0);
}

export function resolveExecutablePath(command: string): string | null {
  if (command.includes(sep) || command.includes('/') || isAbsolute(command)) {
    const absolute = resolve(command);
    if (process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(absolute)) {
      for (const extension of windowsExtensions()) {
        if (isExecutableFile(`${absolute}${extension}`)) return `${absolute}${extension}`;
      }
    }
    return isExecutableFile(absolute) ? absolute : null;
  }

  const searchPaths = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);
  for (const searchPath of searchPaths) {
    const base = join(searchPath, command);
    if (process.platform !== 'win32') {
      if (isExecutableFile(base)) return base;
      continue;
    }
    for (const extension of windowsExtensions()) {
      const candidate = `${base}${extension}`;
      if (isExecutableFile(candidate)) return candidate;
    }
    if (/\.[a-z0-9]+$/i.test(command) && existsSync(base) && isExecutableFile(base)) return base;
  }
  return null;
}

export function isDirectlySpawnable(executablePath: string): boolean {
  if (process.platform !== 'win32') return true;
  return /\.(exe|com)$/i.test(executablePath);
}

export function quoteWindowsArgument(argument: string): string {
  return /[\s"&|<>^()]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

/**
 * `cmd.exe /s /c` removes the outermost pair of quotes before parsing, so a command whose
 * executable path contains spaces has to be wrapped in one extra pair to survive.
 */
export function buildWindowsCommandLine(executablePath: string, args: readonly string[]): string {
  return `"${[executablePath, ...args].map(quoteWindowsArgument).join(' ')}"`;
}

/**
 * Spawns a resolved executable without ever handing user-provided text to a shell.
 *
 * Batch shims such as `codex.cmd` cannot be executed directly on Windows, so they are run through
 * cmd.exe. Every argument passed here is a flag or a path produced by this codebase; free-form
 * instructions are written to stdin by the caller instead, so there is no injection surface.
 */
export function spawnResolvedExecutable(
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (isDirectlySpawnable(executablePath)) {
    return spawn(executablePath, [...args], { ...options, shell: false });
  }
  const commandInterpreter = process.env.ComSpec ?? 'cmd.exe';
  return spawn(
    commandInterpreter,
    ['/d', '/s', '/c', buildWindowsCommandLine(executablePath, args)],
    {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    },
  );
}
