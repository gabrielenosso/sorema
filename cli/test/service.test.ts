import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

/**
 * Held against the service manager itself, because this is where believing the file cost a day.
 *
 * The task on the owner's machine carried `<RestartOnFailure><Count>3</Count><Interval>PT1M</Interval>`
 * and had done since the installer was written. The agent exited 1, Task Scheduler recorded
 * `Last Result: 1`, and it restarted nothing: the task sat in `Ready` while the web app showed the
 * machine offline, and the owner had not rebooted, so the logon trigger was never coming round again.
 *
 * `RestartOnFailure` covers the scheduler being unable to launch the action. A program that launches,
 * runs and exits non-zero is a completed run. Measured on this machine over 4.3 minutes: with only a
 * logon trigger and `Count 3`, an action exiting 1 immediately ran **once**; with the repeating
 * trigger below it ran **five times, one a minute**. Asserting the XML contained `RestartOnFailure`
 * would have passed on the broken version, which is why these register the definition for real.
 */
const onWindows = process.platform === 'win32';
// Never the name the installer uses. Registering under `Sorema Agent` would replace whatever the
// developer running this actually has installed, and `/Delete` at the end would take it away.
const ROUND_TRIP_TASK = 'Sorema Agent (test round trip)';

function deleteTask(taskName: string): void {
  try {
    execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
  } catch {
    // Removing a task that was never registered is the state asked for.
  }
}

function readRegisteredTask(taskName: string): string {
  const bytes = execFileSync('schtasks', ['/Query', '/TN', taskName, '/XML'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // schtasks answers UTF-16 to a console and the console codepage down a pipe, so the encoding is
  // read off the byte order mark rather than assumed. Decoding the wrong one produces text that
  // contains none of the tags being looked for, which reads exactly like a setting that was dropped.
  return bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.toString('utf16le')
    : bytes.toString('utf8');
}

function registerAndReadBack(contents: string, encoding: 'utf8' | 'utf16le'): string {
  const home = mkdtempSync(join(tmpdir(), 'sorema-schtasks-'));
  const file = join(home, 'task.xml');
  writeFileSync(file, contents, { encoding });
  deleteTask(ROUND_TRIP_TASK);
  execFileSync('schtasks', ['/Create', '/TN', ROUND_TRIP_TASK, '/XML', file, '/F'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return readRegisteredTask(ROUND_TRIP_TASK);
}

describe.skipIf(!onWindows)('what Task Scheduler actually keeps', () => {
  afterAll(() => deleteTask(ROUND_TRIP_TASK));

  const plan = planService(process.execPath, [SCRIPT, 'start'], 'win32', mkdtempSync(join(tmpdir(), 'sorema-plan-')));

  it('accepts the definition the installer writes', () => {
    // Element order inside <Settings> and <Triggers> is schema-significant, and schtasks reports a
    // rejection as a parse error at a line number rather than as anything about the setting.
    expect(() => registerAndReadBack(plan.contents, plan.encoding)).not.toThrow();
  });

  it('keeps the repeating trigger, which is the part that restarts the agent', () => {
    const stored = registerAndReadBack(plan.contents, plan.encoding);

    expect(stored).toContain('<TimeTrigger>');
    expect(stored).toContain('<Repetition>');
    expect(stored).toContain('<Interval>PT1M</Interval>');
  });

  it('keeps the policy that stops the repeat from restarting a healthy agent', () => {
    const stored = registerAndReadBack(plan.contents, plan.encoding);

    // Measured: with this, a task whose action ran for four minutes was started once and the
    // per-minute repeats were ignored. Without it the repeat is a restart every minute instead.
    //
    // Worth knowing what this assertion can and cannot fail on: `IgnoreNew` is Task Scheduler's own
    // default, so *deleting* the line leaves the read-back saying `IgnoreNew` anyway and this still
    // passes. What it catches is the policy being changed to `Parallel` or `StopExisting`, either of
    // which turns the repeating trigger into a minute-by-minute restart of a healthy agent. Verified
    // by reversion in exactly that form, because deleting the line proves nothing here.
    expect(stored).toContain('IgnoreNew');
  });

  it('still starts at logon, and still only for its owner', () => {
    const stored = registerAndReadBack(plan.contents, plan.encoding);

    expect(stored).toContain('<LogonTrigger>');
    expect(stored).toContain('<UserId>');
  });

  it('keeps the restart-on-failure settings, for the case they do cover', () => {
    const stored = registerAndReadBack(plan.contents, plan.encoding);

    expect(stored).toContain('<RestartOnFailure>');
    expect(stored).toContain('<Count>3</Count>');
  });
});

/**
 * The behaviour itself, which takes minutes and so is asked for rather than run by default.
 *
 * `SOREMA_VERIFY_SERVICE_RESTART=1 npx vitest run cli/test/service.test.ts`
 *
 * Everything above proves the definition survives registration. This proves the thing the definition
 * is for, against the real scheduler and a real process that dies — the claim that a green suite has
 * no business making from a string comparison.
 */
describe.skipIf(!onWindows || process.env.SOREMA_VERIFY_SERVICE_RESTART !== '1')(
  'a dead agent is started again',
  () => {
    afterAll(() => deleteTask(ROUND_TRIP_TASK));

    it(
      'runs again within a couple of minutes of its process exiting non-zero',
      async () => {
        const home = mkdtempSync(join(tmpdir(), 'sorema-restart-'));
        const log = join(home, 'runs.txt');
        // The real planner, with an action that behaves the way the agent did on the machine this
        // was found on: it starts, records that it did, and exits 1.
        const dying = planService(
          join(String(process.env.SystemRoot ?? 'C:\\Windows'), 'System32', 'cmd.exe'),
          ['/c', `echo ran >> ${log} & exit /b 1`],
          'win32',
          home,
        );
        registerAndReadBack(dying.contents, dying.encoding);
        execFileSync('schtasks', ['/Run', '/TN', ROUND_TRIP_TASK], { stdio: 'ignore' });

        const deadline = Date.now() + 200_000;
        let runs = 0;
        while (Date.now() < deadline && runs < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          runs = existsSync(log)
            ? readFileSync(log, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
            : 0;
        }

        // Two runs is the whole claim: the first is the one we asked for, the second is the
        // scheduler bringing it back on its own. One run is what the shipped version did forever.
        expect(runs).toBeGreaterThanOrEqual(2);
      },
      240_000,
    );
  },
);

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
