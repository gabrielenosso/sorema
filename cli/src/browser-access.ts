import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Durable consent for letting Claude Code act through Chrome.
 *
 * This belongs beside the device identity rather than in a shell environment: the installed agent
 * runs under a user service, usually outside the shell where a variable was set. More importantly,
 * browser access is authority, so an ambient machine-wide variable must not silently grant it.
 */
export const BROWSER_ACCESS_FILE_NAME = 'browser-access.json';

export function browserAccessFilePath(stateDirectory: string): string {
  return join(stateDirectory, BROWSER_ACCESS_FILE_NAME);
}

/** Invalid, missing, or hand-edited state fails closed. */
export function readClaudeChromeAccess(stateDirectory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(browserAccessFilePath(stateDirectory), 'utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { claudeCodeEnabled?: unknown }).claudeCodeEnabled === true
    );
  } catch {
    return false;
  }
}

export function writeClaudeChromeAccess(stateDirectory: string, enabled: boolean): void {
  mkdirSync(stateDirectory, { recursive: true });
  // This is not a secret, but it grants access to a signed-in browser profile. Keep the authority
  // decision writable only by the account whose agent will consume it.
  writeFileSync(
    browserAccessFilePath(stateDirectory),
    `${JSON.stringify({ claudeCodeEnabled: enabled }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // `mode` only applies when writeFileSync creates the file. Restrict an existing file too.
  if (process.platform !== 'win32') {
    chmodSync(browserAccessFilePath(stateDirectory), 0o600);
  }
}
