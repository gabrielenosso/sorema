import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { agentProcessIdPath } from '../../packages/config/src/index.js';

/**
 * Keeping the agent running without asking for the machine.
 *
 * Every one of these installs a **user** service, never a system one. That is the security decision
 * the rest follows from: no administrator prompt, no root, no daemon running as a privileged account
 * with a network socket open. The agent needs exactly the reach its owner already has — it reads the
 * folders they allowed and runs the tools they installed — so anything more would be a liability
 * asking to be exploited rather than a feature.
 *
 * The consequence is that it starts when its owner logs in rather than when the machine boots. That
 * is the right trade: a laptop nobody has unlocked has nothing useful to do with a voice assistant.
 */
export type ServicePlan = {
  label: string;
  path: string;
  contents: string;
  /** Windows needs its task definition in UTF-16 with a byte order mark; nothing else does. */
  encoding: 'utf8' | 'utf16le';
  /**
   * A second file the definition points at, written and removed beside it.
   *
   * Only Windows has one, and only because a scheduled task cannot start the agent itself without
   * putting a console window on somebody's desktop. See `planScheduledTask`.
   */
  launcher: { path: string; contents: string; encoding: 'utf8' | 'utf16le' } | null;
  /**
   * How to stop the agent itself, for a service manager that cannot be asked to.
   *
   * Null wherever stopping the service stops the agent, which is everywhere except Windows.
   */
  stopAgent: { processIdPath: string; imageName: string } | null;
  /** Run first, and allowed to fail: clearing a previous install that may not exist. */
  prepare: readonly (readonly string[])[];
  activate: readonly (readonly string[])[];
  /** Asks the service manager whether it knows about this, which a file on disk does not answer. */
  verify: readonly string[];
  /**
   * Stops and starts it again, for when the identity on disk has changed under a running daemon.
   *
   * Pairing writes a new key and a new device id to disk; a service started before that keeps
   * signing as the machine it used to be, and its socket stays open so it never even retries. The
   * account then shows the old machine connected and the new one as never having appeared.
   */
  restart: readonly (readonly string[])[];
  deactivate: readonly (readonly string[])[];
  describe: string;
};

const LABEL = 'com.sorema.agent';

export function planService(
  executable: string,
  argv: readonly string[],
  system: string = platform(),
  home: string = homedir(),
): ServicePlan {
  if (system === 'darwin') return planLaunchAgent(executable, argv, home);
  if (system === 'win32') return planScheduledTask(executable, argv, home);
  return planSystemdUserUnit(executable, argv, home);
}

/** launchd, in the user's own LaunchAgents rather than /Library, which would need root. */
function planLaunchAgent(executable: string, argv: readonly string[], home: string): ServicePlan {
  const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const programArguments = [executable, ...argv]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join('\n');

  return {
    label: LABEL,
    path,
    encoding: 'utf8',
    launcher: null,
    stopAgent: null,
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
    verify: ['launchctl', 'print', `gui/${process.getuid?.() ?? 0}/${LABEL}`],
    restart: [['launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${LABEL}`]],
    prepare: [['launchctl', 'bootout', `gui/${process.getuid?.() ?? 0}`, path]],
    activate: [['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 0}`, path]],
    deactivate: [['launchctl', 'bootout', `gui/${process.getuid?.() ?? 0}`, path]],
    describe: 'launchd, starting when you log in',
  };
}

/** systemd in user mode: `systemctl --user`, which never touches the system manager. */
function planSystemdUserUnit(
  executable: string,
  argv: readonly string[],
  home: string,
): ServicePlan {
  const path = join(home, '.config', 'systemd', 'user', 'sorema.service');
  const command = [executable, ...argv].map(quoteForSystemd).join(' ');

  return {
    label: 'sorema.service',
    path,
    encoding: 'utf8',
    launcher: null,
    stopAgent: null,
    contents: `[Unit]
Description=Sorema agent
After=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=5
# The agent has no business gaining privileges it was not started with.
NoNewPrivileges=true

[Install]
WantedBy=default.target
`,
    verify: ['systemctl', '--user', 'is-enabled', 'sorema.service'],
    restart: [['systemctl', '--user', 'restart', 'sorema.service']],
    prepare: [],
    activate: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'sorema.service'],
    ],
    deactivate: [
      ['systemctl', '--user', 'disable', '--now', 'sorema.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ],
    describe: 'systemd, starting when you log in',
  };
}

/**
 * A scheduled task that runs at logon, and keeps running.
 *
 * Written as XML and registered with `schtasks /XML` rather than assembled on a command line: the
 * executable path can contain spaces and quotes, and a task definition built by string concatenation
 * is a command injection waiting for a user whose Windows account is called something unusual.
 *
 * **`RestartOnFailure` is not what keeps this alive, and believing it did cost a machine that sat
 * offline for a day.** The task was registered with `<RestartOnFailure><Count>3</Count>` all along,
 * the agent exited 1, the scheduler recorded `Last Result: 1` — and it never restarted it once. That
 * setting covers the scheduler being unable to *launch* the action; a program that launches, runs
 * and exits non-zero is a completed run, not a failure it will retry. Measured on Windows 11 with a
 * task whose action exits 1 immediately: over 4.3 minutes with `Count 3` and `Interval PT1M` it ran
 * exactly once. The same task with the repeating trigger below ran five times, once a minute.
 *
 * So the thing that actually restarts the agent is the `TimeTrigger`: a boundary far in the past and
 * an indefinite repetition, which asks the scheduler to start the task every minute, forever. The
 * task no longer depends on a logon that may not happen again for weeks, which is the state the
 * owner's machine was in — `Ready`, never rebooted, and nothing left to trigger it.
 *
 * `MultipleInstancesPolicy` is what makes that safe rather than a restart every minute: measured the
 * same way, a task with this trigger whose action runs for four minutes was started **once**, and
 * the repeats were ignored while it was alive. `IgnoreNew` is load-bearing here, not tidiness.
 *
 * `RestartOnFailure` is kept because the case it does cover is real and costs nothing.
 *
 * **The task does not start the agent; it starts a script that starts the agent, hidden.** A task
 * pointing `<Command>` straight at `node.exe` is started the way a shortcut would start it, and
 * node is a console program, so a black console window sat on the owner's desktop for as long as
 * the agent ran — found on his own machine minutes after installing. Closing it, which anyone
 * would, kills the agent and takes the machine offline with nothing said. `<Hidden>` does not
 * address this: it hides the task in the Task Scheduler list, not the window.
 *
 * `wscript.exe` has no console of its own, so nothing flashes, and it starts the agent with the
 * window hidden and waits for it. The waiting is what keeps the rest of this working: the task stays
 * `Running` for the agent's whole life, so `IgnoreNew` goes on ignoring the repeating trigger above,
 * and the agent's exit code still reaches `Last Result`. Measured on Windows 11: through the script
 * the started process reports its console window invisible; pointed at node directly it reports it
 * visible.
 *
 * What it costs is the stop. **Task Scheduler terminates the process it started and nothing
 * underneath it** — measured, with a `wscript` parent and again with a `powershell` one — so
 * `schtasks /End` now ends the launcher and leaves the agent running. That is why `stopAgent` is
 * here: the agent is stopped by the process id it publishes once it holds the loopback port, and
 * only then is the task ended and started again. Without it the restart after pairing would start
 * an agent that dies on the port the orphan still holds, and the machine would go on answering as
 * the identity it had before — the exact failure `restart` exists to prevent.
 */
function planScheduledTask(executable: string, argv: readonly string[], home: string): ServicePlan {
  const stateDirectory = join(home, '.sorema');
  const path = join(stateDirectory, 'sorema-agent-task.xml');
  const launcherPath = join(stateDirectory, 'sorema-agent-launch.vbs');
  const commandLine = [executable, ...argv].map(quoteForWindows).join(' ');

  return {
    label: 'Sorema Agent',
    path,
    encoding: 'utf16le',
    launcher: {
      path: launcherPath,
      // Same encoding as the task for the same reason: the path of a user whose account name is not
      // ASCII has to survive, and the script host reads the byte order mark to decide.
      encoding: 'utf16le',
      contents: `\uFEFF${launcherScript(commandLine)}`,
    },
    stopAgent: {
      processIdPath: agentProcessIdPath(stateDirectory),
      // The agent runs under whatever started this command, so the guard names that program rather
      // than assuming `node.exe`.
      imageName: basename(executable),
    },
    contents: `\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sorema agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(windowsUser())}</UserId></LogonTrigger>
    <TimeTrigger>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Repetition><Interval>PT1M</Interval></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(windowsUser())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(windowsScriptHost())}</Command>
      <Arguments>${escapeXml(quoteForWindows(launcherPath))}</Arguments>
    </Exec>
  </Actions>
</Task>
`,
    verify: ['schtasks', '/Query', '/TN', 'Sorema Agent'],
    restart: [
      ['schtasks', '/End', '/TN', 'Sorema Agent'],
      ['schtasks', '/Run', '/TN', 'Sorema Agent'],
    ],
    prepare: [],
    activate: [
      ['schtasks', '/Create', '/TN', 'Sorema Agent', '/XML', path, '/F'],
      // Creating a task does not run it, and the trigger is the next logon. Without this the
      // machine sits registered and offline until the user happens to sign out, which reads as the
      // install having done nothing.
      ['schtasks', '/Run', '/TN', 'Sorema Agent'],
    ],
    deactivate: [['schtasks', '/Delete', '/TN', 'Sorema Agent', '/F']],
    describe: 'Task Scheduler, starting when you log in and coming back if it stops',
  };
}

/**
 * The program the task starts, which is not the agent.
 *
 * Resolved from `SystemRoot` rather than written as a bare name, so the scheduler is not left to
 * search a path it does not necessarily have, and rather than hardcoding `C:\\Windows`, which is
 * only the usual answer.
 */
function windowsScriptHost(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
}

/**
 * The four lines that keep a console window off somebody's desktop.
 *
 * The reasoning is in `planScheduledTask` and is repeated at the top of the file itself, because
 * the file lands in a user's home directory where nobody will have this source to hand — and an
 * unexplained script that launches something invisibly is exactly what a person should be
 * suspicious of finding there.
 */
function launcherScript(commandLine: string): string {
  return `' Starts the Sorema agent, with no window.
'
' Written by "sorema service install". Anything changed here is lost the next time it runs.
'
' Task Scheduler starts a program the way opening a shortcut would, and the agent is a Node
' program, which means a console. Pointed straight at node, the task left a black terminal on the
' desktop for as long as the agent ran. Closing it — which anyone would — kills the agent, and the
' machine goes offline without saying so. Run's second argument, 0, starts it hidden instead, and
' wscript.exe has no console of its own, so nothing appears even for a moment.
'
' The third argument, True, waits for the agent rather than returning at once. That is not a
' detail: it keeps this process alive for as long as the agent, so the scheduled task stays
' Running, so the trigger that repeats every minute goes on being ignored instead of starting a
' second agent every minute. Waiting is also what carries the agent's exit code back to the task.
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run("${quoteForVisualBasicString(commandLine)}", 0, True)
`;
}

/**
 * Who the task belongs to.
 *
 * Without it a logon trigger fires for *any* account on the machine, which is the one place this
 * design would otherwise leak past "a service for its owner".
 */
function windowsUser(): string {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME ?? '';
  // Joined with a literal backslash, which is what Windows means by DOMAIN\user. Written this way
  // rather than escaped inside the template, where a stray backslash silently turns `${user}` into
  // the four characters instead of the name and the task is registered for a user nobody has.
  return domain ? [domain, user].join('\\') : user;
}

/**
 * Paths that will not still be there.
 *
 * A service definition is written once and read for years, so it must not point into somewhere its
 * owner treats as disposable. An `npx` run lives in a cache npm clears; a Node from nvm, fnm or
 * Volta moves when the user installs another version. Either way the agent stops starting and says
 * nothing — it is simply never there again, which is the worst way for this to fail.
 */
export function findRottingPath(executable: string, argv: readonly string[]): string | null {
  const disposable = [
    { pattern: /[\\/]_npx[\\/]/, why: 'the npx cache, which npm clears' },
    { pattern: /[\\/]\.nvm[\\/]/, why: 'an nvm install, which moves between Node versions' },
    { pattern: /[\\/](\.fnm|fnm_multishells)[\\/]/, why: 'an fnm shell, which is temporary' },
    { pattern: /[\\/]\.volta[\\/]/, why: 'a Volta install, which moves between Node versions' },
  ];
  for (const candidate of [executable, ...argv]) {
    for (const { pattern, why } of disposable) {
      if (pattern.test(candidate)) return `${candidate} lives in ${why}`;
    }
  }
  return null;
}

export type Runner = (command: readonly string[]) => void;

/**
 * How to invoke npm without a shell.
 *
 * On Windows `npm` is `npm.cmd`, a batch file, and Node cannot execute one directly — `execFile`
 * fails before the program ever runs, which is why the error carried no output at all. Running npm's
 * own JavaScript entry point through the Node that is already executing avoids both the batch file
 * and the shell that would otherwise be needed to read it.
 */
function npmCommand(): string[] {
  if (platform() !== 'win32') return ['npm'];
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? [process.execPath, cli] : ['npm.cmd'];
}

/**
 * Installs this command properly, so the service can point at something that lasts.
 *
 * Running from an `npx` cache is fine for trying it; it is not fine for a service, because npm is
 * free to clear that directory and the agent would then simply never start again, silently. Rather
 * than send the reader away to run a second command, the first one does it — and says so, because a
 * program that installs itself without mentioning it is a program nobody should run.
 */
export function installGlobally(version: string, runner: Runner = run): string | null {
  // Inside the try, not above it. A global install fails for ordinary reasons — no permission on
  // the prefix, no network, a registry behind a proxy — and every one of them threw straight past
  // the caller's fallback, so instead of running in the foreground the command simply died.
  try {
    runner([...npmCommand(), 'install', '--global', `sorema@${version}`]);
    const [program, ...prefix] = npmCommand();
    const root = execFileSync(program ?? 'npm', [...prefix, 'root', '--global'], {
      encoding: 'utf8',
    }).trim();
    const script = join(root, 'sorema', 'dist', 'sorema.mjs');
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Whether the service manager actually knows about this service.
 *
 * Deliberately not `existsSync(plan.path)`. A failed registration leaves the definition file behind,
 * and a file on disk then reads as "installed" while nothing runs — which is how a machine came to
 * report itself connected with no agent on it at all. Only the manager can answer this.
 */
/**
 * Restarts the service so it reads the identity that is on disk now.
 *
 * The stop is allowed to fail: on Windows `schtasks /End` errors when the task is not running, and
 * that is the ordinary case, not a problem.
 */
export function restartService(plan: ServicePlan, runner: Runner = run): void {
  stopAgent(plan, runner);
  for (const command of plan.restart) {
    try {
      runner(command);
    } catch {
      // Stopping something that is not running is not a failure worth reporting.
    }
  }
}

/**
 * Ends the agent process itself, where ending the service does not.
 *
 * Measured against Task Scheduler on Windows 11, with a `wscript` parent and again with a
 * `powershell` one: **it terminates the process it started and nothing underneath it.** Since the
 * task starts a launcher, `/End` and `/Delete` both leave the agent running, orphaned. The restart
 * that followed would then start an agent that dies on the loopback port the orphan is still
 * holding, and the machine would go on answering as the identity it had before pairing moved it —
 * which is the whole of what `restart` is for.
 *
 * The id is read rather than searched for. The agent writes it only once it holds that port, so the
 * file names the single writer rather than any node process that happens to be about. The image
 * name is checked as well because a process id outlives the process it named and Windows hands them
 * out again, and the file is cleared either way: the agent is killed rather than asked, so it never
 * gets to clear it itself.
 */
function stopAgent(plan: ServicePlan, runner: Runner): void {
  if (!plan.stopAgent || !existsSync(plan.stopAgent.processIdPath)) return;
  const published = Number.parseInt(readFileSync(plan.stopAgent.processIdPath, 'utf8').trim(), 10);
  rmSync(plan.stopAgent.processIdPath, { force: true });
  if (!Number.isSafeInteger(published) || published <= 0) return;
  try {
    runner([
      'taskkill',
      '/F',
      '/FI',
      `PID eq ${published}`,
      '/FI',
      `IMAGENAME eq ${plan.stopAgent.imageName}`,
    ]);
  } catch {
    // An agent that has already gone is the state being asked for, not a failure.
  }
}

export function isServiceInstalled(plan: ServicePlan, runner: Runner = run): boolean {
  try {
    runner(plan.verify);
    return true;
  } catch {
    return false;
  }
}

export function installService(plan: ServicePlan, runner: Runner = run): void {
  for (const command of plan.prepare) {
    try {
      runner(command);
    } catch {
      // Clearing an install that was never there is the state asked for, not a failure.
    }
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.contents, { encoding: plan.encoding, mode: 0o600 });
  // Rewritten explicitly: an existing file keeps the mode it already had.
  chmodSync(plan.path, 0o600);
  // Before activating, not after: the definition points at this file, and the scheduler runs the
  // task the moment it is created.
  if (plan.launcher) {
    mkdirSync(dirname(plan.launcher.path), { recursive: true });
    writeFileSync(plan.launcher.path, plan.launcher.contents, {
      encoding: plan.launcher.encoding,
      mode: 0o600,
    });
    chmodSync(plan.launcher.path, 0o600);
  }
  try {
    for (const command of plan.activate) runner(command);
  } catch (error) {
    // Leaving the definition behind would make the next run believe the service exists.
    if (existsSync(plan.path)) rmSync(plan.path);
    if (plan.launcher && existsSync(plan.launcher.path)) rmSync(plan.launcher.path);
    throw error;
  }
}

export function uninstallService(plan: ServicePlan, runner: Runner = run): void {
  // First, while the definition still exists to be stopped through. Deleting the task on Windows
  // leaves the agent running, so removing the service and then walking away would leave a daemon
  // nothing on the machine now refers to.
  stopAgent(plan, runner);
  for (const command of plan.deactivate) {
    try {
      runner(command);
    } catch {
      // Removing something already absent is the outcome asked for, not a failure.
    }
  }
  if (existsSync(plan.path)) rmSync(plan.path);
  if (plan.launcher && existsSync(plan.launcher.path)) rmSync(plan.launcher.path);
}

/**
 * Arguments are passed as an array, never through a shell.
 *
 * `execFileSync` without `shell: true` means the home directory, the executable path and everything
 * else reach the program as separate arguments. A path with a space or a quote in it is then just a
 * path, rather than a place where somebody else's words become commands.
 */
function run(command: readonly string[]): void {
  const [program, ...args] = command;
  if (!program) return;
  try {
    // stderr is captured rather than discarded: launchctl and schtasks say what is wrong there, and
    // throwing away the only explanation leaves the user with `Command failed` and nowhere to go.
    execFileSync(program, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? '').trim();
    throw new Error(`${program} failed${said ? `: ${said}` : ''}`);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function quoteForSystemd(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
}

function quoteForWindows(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * A quote inside a VBScript string literal is written twice.
 *
 * Without this a path containing one would close the literal early and the rest of the command
 * would be read as code — the same hazard the task definition avoids by being XML rather than a
 * command line, reappearing in the file that XML now points at.
 */
function quoteForVisualBasicString(value: string): string {
  return value.replace(/"/g, '""');
}
