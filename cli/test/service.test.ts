import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findRottingPath,
  installGlobally,
  installService,
  isServiceInstalled,
  planService,
  uninstallService,
} from '../src/service.js';

const HOME = '/home/gabriele';
const NODE = '/usr/bin/node';
const SCRIPT = '/usr/lib/sorema/dist/sorema.mjs';

/** Nothing here installs anything: the planner is pure, and the runner is handed in. */
function recordingRunner() {
  const commands: (readonly string[])[] = [];
  const runner = (command: readonly string[]) => {
    commands.push(command);
  };
  return { commands, runner };
}

describe('what gets written for each platform', () => {
  it.each(['darwin', 'linux', 'win32'])('produces a definition for %s', (system) => {
    const plan = planService(NODE, [SCRIPT, 'start'], system, HOME);

    expect(plan.path.startsWith(HOME) || plan.path.includes('sorema')).toBe(true);
    expect(plan.contents).toContain(SCRIPT);
    expect(plan.activate.length).toBeGreaterThan(0);
    expect(plan.deactivate.length).toBeGreaterThan(0);
  });

  it('writes bytes that match the encoding the windows file declares', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-encoding-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'win32', home);
    installService(plan, () => {});
    const bytes = readFileSync(plan.path);

    // Both directions of this were shipped and both were refused with "unable to switch the
    // encoding": schtasks hands the file to MSXML, which believes the byte order mark over the
    // declaration. Asserting on the string cannot see it — the text reads correctly either way —
    // so this reads the bytes and checks they agree with what the declaration promises.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(bytes.toString('utf16le')).toContain('encoding="UTF-16"');
  });

  it('binds the windows task to one account rather than to any logon', () => {
    const plan = planService(NODE, [SCRIPT, 'start'], 'win32', HOME);

    // Without this the trigger fires when anyone on the machine logs in.
    expect(plan.contents.match(/<UserId>/g) ?? []).toHaveLength(2);
  });

  it('lets the macOS install clear a previous one without failing when there is none', () => {
    const plan = planService(NODE, [SCRIPT, 'start'], 'darwin', HOME);

    // The clearing step is separate precisely so it may fail: on a fresh machine there is nothing
    // to boot out, and treating that as an error reported a failure over a service that was live.
    expect(plan.prepare.length).toBe(1);
    expect(plan.prepare[0]?.join(' ')).toContain('bootout');
  });

  it('writes exactly one ExecStart, whatever the paths contain', () => {
    const awkward = '/home/some one/node';
    const plan = planService(awkward, [SCRIPT, 'start'], 'linux', HOME);
    const execLines = plan.contents.split('\n').filter((line) => line.startsWith('ExecStart='));

    expect(execLines).toHaveLength(1);
    expect(execLines[0]).toContain('some one');
  });

  it.each([
    ['a quote', '/home/o"dd/node'],
    ['an ampersand', '/home/a&b/node'],
    ['a less-than sign', '/home/a<b/node'],
    ['plist markup', '/home/x</string><key>RunAtLoad</key><false/><string>/node'],
  ])('escapes %s so the definition stays parseable', (_case, executable) => {
    for (const system of ['darwin', 'win32']) {
      const plan = planService(executable, [SCRIPT, 'start'], system, HOME);

      // The raw characters must not survive into the markup, or the file stops being the file.
      expect(plan.contents).not.toContain('<key>RunAtLoad</key><false/>');
      expect(plan.contents.split('<').length).toBeGreaterThan(1);
    }
  });
});

describe('refusing to point at a path that will not last', () => {
  it.each([
    ['an npx cache', '/home/g/.npm/_npx/abc123/node_modules/.bin/sorema'],
    ['an nvm install', '/home/g/.nvm/versions/node/v22.0.0/bin/node'],
    ['an fnm shell', '/home/g/.local/state/fnm_multishells/1234/bin/node'],
    ['a volta install', '/home/g/.volta/tools/image/node/22.0.0/bin/node'],
  ])('refuses %s', (_case, path) => {
    expect(findRottingPath(path, [])).not.toBeNull();
    expect(findRottingPath(NODE, [path])).not.toBeNull();
  });

  it('accepts an install that stays put', () => {
    expect(findRottingPath(NODE, [SCRIPT])).toBeNull();
  });

  it('recognises a windows path as readily as a posix one', () => {
    expect(findRottingPath('C:\\Users\\g\\.npm\\_npx\\abc\\sorema.mjs', [])).not.toBeNull();
  });
});

describe('installing and removing', () => {
  it('writes the definition, then activates, in that order', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);
    const { commands, runner } = recordingRunner();

    installService(plan, runner);

    expect(readFileSync(plan.path, 'utf8')).toBe(plan.contents);
    expect(commands).toEqual([...plan.prepare, ...plan.activate]);
  });

  it('keeps the definition readable only by its owner', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);

    installService(plan, () => {});

    // Meaningless on Windows, where the protection comes from the profile's own permissions.
    if (process.platform !== 'win32') {
      expect(statSync(plan.path).mode & 0o777).toBe(0o600);
    }
  });

  it('does not treat a missing previous install as a failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'darwin', home);

    expect(() =>
      installService(plan, (command) => {
        if (command.includes('bootout')) throw new Error('nothing to boot out');
      }),
    ).not.toThrow();
    expect(existsSync(plan.path)).toBe(true);
  });

  it('removes the definition even when the service manager complains', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);
    installService(plan, () => {});

    uninstallService(plan, () => {
      throw new Error('no user bus over ssh');
    });

    expect(existsSync(plan.path)).toBe(false);
  });

  it('removing something already gone is not an error', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);

    expect(() => uninstallService(plan, () => {})).not.toThrow();
  });

  it('passes every command as separate arguments, so no shell can interpret them', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);
    const { commands, runner } = recordingRunner();

    installService(plan, runner);

    for (const command of commands) {
      expect(Array.isArray(command)).toBe(true);
      expect(command.join(' ')).not.toContain('&&');
    }
  });

  it('never asks the operating system to run a bare npm on windows', () => {
    const commands: (readonly string[])[] = [];

    installGlobally('9.9.9', (command) => commands.push(command));

    const [invocation] = commands;
    // `npm` on Windows is a batch file, which execFile cannot run: it fails before producing any
    // output, so the failure arrives with nothing to explain it.
    if (process.platform === 'win32') {
      expect(invocation?.[0]).not.toBe('npm');
    }
    expect(invocation).toContain('install');
    expect(invocation).toContain('sorema@9.9.9');
  });

  it('asks the service manager, not the filesystem, whether it is installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-installed-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'win32', home);
    installService(plan, () => {});

    // The file exists and the service does not: exactly the state a failed registration leaves, and
    // the state that had a machine reporting itself connected with no agent running on it.
    expect(existsSync(plan.path)).toBe(true);
    expect(
      isServiceInstalled(plan, () => {
        throw new Error('ERROR: The system cannot find the file specified.');
      }),
    ).toBe(false);
    expect(isServiceInstalled(plan, () => {})).toBe(true);
  });

  it('clears the definition when registering it fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-failed-'));
    const plan = planService(NODE, [SCRIPT, 'start'], 'linux', home);

    expect(() =>
      installService(plan, (command) => {
        if (command.includes('enable')) throw new Error('refused');
      }),
    ).toThrow();
    // Left behind, the next run would take it for a working install.
    expect(existsSync(plan.path)).toBe(false);
  });

  it('names a real windows account, not the template that should have produced one', () => {
    const previousDomain = process.env.USERDOMAIN;
    const previousUser = process.env.USERNAME;
    process.env.USERDOMAIN = 'DESKTOP-ABC';
    process.env.USERNAME = 'gabriele';
    try {
      const plan = planService(NODE, [SCRIPT, 'start'], 'win32', HOME);

      // schtasks answers "No mapping between account names and security IDs" when the identity is
      // not a real account, which is what an uninterpolated template produces.
      expect(plan.contents).toContain(['DESKTOP-ABC', 'gabriele'].join('\\'));
      expect(plan.contents).not.toContain('${');
    } finally {
      if (previousDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = previousDomain;
      if (previousUser === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUser;
    }
  });
});
