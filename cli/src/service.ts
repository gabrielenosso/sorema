import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

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
  /** Run first, and allowed to fail: clearing a previous install that may not exist. */
  prepare: readonly (readonly string[])[];
  activate: readonly (readonly string[])[];
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
 * A scheduled task that runs at logon.
 *
 * Written as XML and registered with `schtasks /XML` rather than assembled on a command line: the
 * executable path can contain spaces and quotes, and a task definition built by string concatenation
 * is a command injection waiting for a user whose Windows account is called something unusual.
 */
function planScheduledTask(executable: string, argv: readonly string[], home: string): ServicePlan {
  const path = join(home, '.sorema', 'sorema-agent-task.xml');
  const argumentsText = argv.map(quoteForWindows).join(' ');

  return {
    label: 'Sorema Agent',
    path,
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sorema agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(windowsUser())}</UserId></LogonTrigger>
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
      <Command>${escapeXml(executable)}</Command>
      <Arguments>${escapeXml(argumentsText)}</Arguments>
    </Exec>
  </Actions>
</Task>
`,
    prepare: [],
    activate: [['schtasks', '/Create', '/TN', 'Sorema Agent', '/XML', path, '/F']],
    deactivate: [['schtasks', '/Delete', '/TN', 'Sorema Agent', '/F']],
    describe: 'Task Scheduler, starting when you log in',
  };
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
  return domain ? `${domain}\${user}` : user;
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

export function isServiceInstalled(plan: ServicePlan): boolean {
  return existsSync(plan.path);
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
  writeFileSync(plan.path, plan.contents, { encoding: 'utf8', mode: 0o600 });
  // Rewritten explicitly: an existing file keeps the mode it already had.
  chmodSync(plan.path, 0o600);
  for (const command of plan.activate) runner(command);
}

export function uninstallService(plan: ServicePlan, runner: Runner = run): void {
  for (const command of plan.deactivate) {
    try {
      runner(command);
    } catch {
      // Removing something already absent is the outcome asked for, not a failure.
    }
  }
  if (existsSync(plan.path)) rmSync(plan.path);
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
