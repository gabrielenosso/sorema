import { hostname, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { looksLikePairingCode } from './commands.js';
import { readClaudeChromeAccess, writeClaudeChromeAccess } from './browser-access.js';
import {
  describeUnsupportedNodeVersion,
  nodeVersionHasBuiltInSqlite,
} from '../../apps/local-agent/src/db/sqlite-runtime.js';
import {
  describeWorkspaceRootProblem,
  expandWorkspaceRoot,
  readWorkspaceRoots,
  suggestWorkspaceRoot,
  writeWorkspaceRoots,
} from './workspace-roots.js';

declare const __SOREMA_API_URL__: string;
declare const __SOREMA_TUNNEL_URL__: string;

/**
 * Where the deployed service lives, substituted at build time rather than written here.
 *
 * Somebody installing this should not have to know that an API endpoint exists, so the published
 * command carries the addresses. The source does not: a repository that names its own production
 * endpoints hands a reader a target list, and there is no reason for the two to be the same file.
 *
 * Anyone building from source supplies their own, which is exactly what a second deployment needs.
 */
const DEFAULT_API_URL = typeof __SOREMA_API_URL__ === 'string' ? __SOREMA_API_URL__ : '';
const DEFAULT_TUNNEL_URL = typeof __SOREMA_TUNNEL_URL__ === 'string' ? __SOREMA_TUNNEL_URL__ : '';

const VERSION = '0.9.8';

const USAGE = `sorema — run work on this machine, by voice, from anywhere.

  sorema <CODE>              Do everything: pair, install, connect. Run it again any time.
  sorema pair <CODE>         Claim the code shown in the web app. Once per machine.
  sorema start               Stay connected. Leave it running.
  sorema projects            Say which folder your projects come from.
  sorema projects <FOLDER>   Change it, for when your code moves.
  sorema chrome enable       Let Claude Code use your signed-in Chrome profile.
  sorema chrome disable      Remove that browser access (the default).
  sorema chrome status       Show whether browser access is allowed.
  sorema service install     Start on its own whenever you log in.
  sorema service uninstall   Stop doing that.
  sorema status              Say whether this machine is paired, and as whom.

The private key that identifies this machine is generated here and never leaves.
`;

/**
 * State lives under the user's home directory, not beside the installed package.
 *
 * An npx install is a cache that gets cleared; a machine's identity is not something to lose because
 * a package manager tidied up. Losing it would mean the device silently going dark and needing to be
 * paired again, with the old registration left behind.
 */
function stateDirectory(): string {
  // Resolved once, from the same variable the agent reads. Hardcoding the home directory here is
  // what made `status` and `start` answer the same question differently.
  const directory = process.env.LOCAL_AGENT_STATE_DIR ?? join(homedir(), '.sorema');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function applyDefaults(): void {
  if (DEFAULT_API_URL) process.env.SOREMA_API_URL ??= DEFAULT_API_URL;
  if (DEFAULT_TUNNEL_URL) process.env.SOREMA_TUNNEL_URL ??= DEFAULT_TUNNEL_URL;
  // The names the agent's configuration actually reads. Setting anything else means the CLI stores
  // an identity in one directory while the agent looks for it in another, and the two answer the
  // same question differently: `status` says paired, `start` says it is not.
  process.env.LOCAL_AGENT_STATE_DIR ??= stateDirectory();
  process.env.LOCAL_AGENT_DATABASE_URL ??= `file:${join(stateDirectory(), 'sorema.sqlite')}`;
  process.env.LOCAL_AGENT_DEVICE_NAME ??= `${hostname()} (${platform()})`;
  // Read from disk rather than asked for here: `start` runs under a service with no terminal, so
  // the answer given once at pairing has to reach it some other way. Left empty when nothing has
  // been chosen, because the agent then reports itself misconfigured — which is true, and visible —
  // rather than quietly offering up a folder nobody named.
  process.env.LOCAL_AGENT_WORKSPACE_ROOTS ??= readWorkspaceRoots(stateDirectory()).join(',');
  // Forced from durable, owner-only consent rather than inherited from the shell. Browser access
  // reaches signed-in sites, so an ambient or machine-wide variable must not silently grant it to
  // the service. `sorema chrome enable` is the one explicit path that changes this value.
  process.env.CLAUDE_CODE_CHROME_ENABLED = readClaudeChromeAccess(stateDirectory())
    ? 'true'
    : 'false';
  // Off by default: somebody who installed this wants it to do the work, not to mime it.
  process.env.SOREMA_DEMO_MODE ??= 'false';
  // Forced, not defaulted. The logger picks a pretty-printing transport whenever this is not
  // 'production', and that transport is resolved by module path, which a single file cannot
  // satisfy, so the command dies in 400ms. Plenty of people export NODE_ENV=development in their
  // shell, and their environment must not decide whether our own bundle can start.
  process.env.NODE_ENV = 'production';
}

/**
 * Asks before moving this machine to a different account.
 *
 * Without a terminal there is nobody to ask, so it refuses rather than guessing — a service or a
 * script re-pairing a machine on its own is how a working setup disappears without anyone deciding.
 */
async function confirmRepairing(deviceId: string): Promise<boolean> {
  process.stdout.write(
    `This machine is already paired, as ${deviceId}.\n` +
      'Pairing again moves it to whichever account this code belongs to, and it stops answering ' +
      'for the old one.\n',
  );
  if (!process.stdin.isTTY) {
    process.stdout.write('Run it again from a terminal to confirm.\n');
    return false;
  }

  const { createInterface } = await import('node:readline/promises');
  const question = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await question.question('Move it? [y/N] ');
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    question.close();
  }
}

function applyWorkspaceRoots(roots: readonly string[]): void {
  writeWorkspaceRoots(stateDirectory(), roots);
  // This process may go on to run the agent in the foreground, and applyDefaults read the file as it
  // was before the question was asked.
  process.env.LOCAL_AGENT_WORKSPACE_ROOTS = roots.join(',');
}

/**
 * Asks where the user keeps their code, and writes the answer down.
 *
 * This is the question nobody was ever asked. The agent lists the folders under these roots as the
 * projects it can work on, and refuses every path outside them, so with none set it offers nothing
 * and the assistant reports — correctly, from where it sits — that this machine has no projects.
 *
 * A wrong root is worse than no root, because it is the boundary the coding agents are held to. So
 * without a terminal this refuses to guess, and the suggestion is only ever a folder that already
 * exists and is conventionally full of code.
 */
async function chooseWorkspaceRoots(): Promise<void> {
  const suggestion = suggestWorkspaceRoot();
  process.stdout.write(
    '\nWhere do you keep your code?\n' +
      'The folders inside it become your projects, and it is the only place anything running here\n' +
      'is allowed to read or change.\n',
  );

  if (!process.stdin.isTTY) {
    // A service has no terminal, and neither does a script. Guessing here would decide what the
    // coding agents may touch on somebody's behalf, without them ever seeing the question.
    process.stdout.write(
      `Nothing to ask with here, so nothing was assumed.\n` +
        `Run: sorema projects ${suggestion ?? '<FOLDER>'}\n`,
    );
    return;
  }

  const { createInterface } = await import('node:readline/promises');
  const question = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await question.question(suggestion ? `Folder [${suggestion}]: ` : 'Folder: ');
      const typed = answer.trim();
      const chosen = typed.length > 0 ? expandWorkspaceRoot(typed) : suggestion;
      if (!chosen) continue;
      // Both, for the same reason as in `projects`: once resolved, a drive-relative path looks like
      // a perfectly ordinary absolute one pointing at a folder nobody named.
      const problem = describeWorkspaceRootProblem(chosen, typed.length > 0 ? typed : chosen);
      if (problem) {
        process.stdout.write(`${problem}.\n`);
        continue;
      }
      applyWorkspaceRoots([chosen]);
      process.stdout.write(`Your projects are the folders in ${chosen}.\n`);
      return;
    }
    process.stdout.write('Left unset. Run: sorema projects <FOLDER> when you know.\n');
  } finally {
    question.close();
  }
}

async function main(): Promise<number> {
  // Said here, before anything else, so somebody on an old Node learns it while pairing rather than
  // days later when the service they installed turns out never to have started. The store refuses
  // for itself as well, because that is the last thing between a frame and the file; this is the
  // courtesy, and it is the one a person actually reads.
  if (!nodeVersionHasBuiltInSqlite(process.versions.node)) {
    process.stderr.write(`${describeUnsupportedNodeVersion(process.versions.node)}\n`);
    return 1;
  }

  applyDefaults();
  const [command, argument] = process.argv.slice(2);

  if (!process.env.SOREMA_API_URL || !process.env.SOREMA_TUNNEL_URL) {
    process.stderr.write(
      'This build does not know which deployment to talk to.\n' +
        'Set SOREMA_API_URL and SOREMA_TUNNEL_URL, or install the published command.\n',
    );
    return 1;
  }

  if (command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { DeviceIdentityStore } =
    await import('../../apps/local-agent/src/identity/device-identity-store.js');
  const identity = new DeviceIdentityStore(stateDirectory());

  // Everything, in one command: `sorema` on its own, or `sorema <CODE>` the first time. It works
  // out what is missing and does only that, so running it twice costs nothing.
  const looksLikeCode = looksLikePairingCode(command);
  if (!command || looksLikeCode) {
    const {
      planService,
      installService,
      isServiceInstalled,
      findRottingPath,
      installGlobally,
      restartService,
    } = await import('./service.js');
    const { planSetup } = await import('./setup.js');

    let argv = [process.argv[1], 'start'].filter((value): value is string => Boolean(value));
    let plan = planService(process.execPath, argv);
    const steps = planSetup({
      paired: identity.isPaired,
      code: looksLikeCode ? command.replace('-', '').toUpperCase() : null,
      rottingPath: findRottingPath(process.execPath, argv),
      serviceInstalled: isServiceInstalled(plan),
      workspaceRootsConfigured: readWorkspaceRoots(stateDirectory()).length > 0,
    });

    for (const step of steps) {
      if (step.action === 'explain') process.stdout.write(`${step.message}\n`);
      if (step.action === 'pair') {
        // Asked, not assumed. Re-pairing moves this machine to another account and throws away the
        // key it answers with, so it is not something to do quietly because a code was typed.
        if (identity.isPaired && !(await confirmRepairing(identity.deviceId ?? ''))) {
          process.stdout.write('Left as it is.\n');
          return 0;
        }
        // Kept until the move succeeds. Discarding the key first meant a mistyped or expired code
        // left the machine paired to nothing: the old identity gone, the new one never accepted.
        const previous = identity.snapshot();
        if (identity.isPaired) identity.reset();
        const { pairWithCode } = await import('../../apps/local-agent/src/tunnel/cloud-pairing.js');
        try {
          const paired = await pairWithCode(
            String(process.env.SOREMA_API_URL),
            step.code,
            identity,
            String(process.env.LOCAL_AGENT_DEVICE_NAME),
          );
          process.stdout.write(`Paired as ${paired.deviceId}.\n`);
        } catch (error) {
          identity.restore(previous);
          throw error;
        }
      }
      if (step.action === 'choose-projects') await chooseWorkspaceRoots();
      if (step.action === 'install-globally') {
        const durable = installGlobally(VERSION);
        if (!durable) {
          process.stdout.write(
            'Could not install it globally, so it will run here instead.\nLeave this window open.\n',
          );
          const { runAgent } = await import('../../apps/local-agent/src/run.js');
          await runAgent();
          return 0;
        }
        // The service must point at the copy that will still be there, not at the one running now.
        argv = [durable, 'start'];
        plan = planService(process.execPath, argv);
      }
      if (step.action === 'install-service') {
        installService(plan);
        process.stdout.write(`Running under ${plan.describe}. Nothing else to start.\n`);
      }
      if (step.action === 'restart-service') {
        restartService(plan);
        process.stdout.write('Restarted it, so it answers as this machine and not the old one.\n');
      }
      if (step.action === 'already-running') {
        // Deliberately not "connected": nothing here has watched a socket open. Saying it and being
        // wrong is what made the last three attempts look like successes.
        process.stdout.write(
          'Sorema is running here. The web app shows a green dot once it has connected.\n',
        );
      }
      if (step.action === 'run-in-foreground') {
        const { runAgent } = await import('../../apps/local-agent/src/run.js');
        await runAgent();
      }
    }
    return steps.some((step) => step.action === 'explain' && !identity.isPaired) ? 1 : 0;
  }

  if (command === 'status') {
    process.stdout.write(
      identity.isPaired
        ? `Paired as ${identity.deviceId}.\n`
        : 'Not paired. Run: sorema pair <CODE>\n',
    );
    // Said here because a paired machine offering no projects looks, from the web app, exactly like
    // a broken one, and nothing on either side used to mention which folder it was reading.
    const roots = readWorkspaceRoots(stateDirectory());
    process.stdout.write(
      roots.length === 0
        ? 'No projects folder set, so this machine offers none. Run: sorema projects <FOLDER>\n'
        : `Projects come from ${roots.join(', ')}.\n`,
    );
    process.stdout.write(
      readClaudeChromeAccess(stateDirectory())
        ? 'Claude Code Chrome access is enabled.\n'
        : 'Claude Code Chrome access is disabled. Run: sorema chrome enable\n',
    );
    return 0;
  }

  if (command === 'chrome') {
    if (argument === 'status' || argument === undefined) {
      process.stdout.write(
        readClaudeChromeAccess(stateDirectory())
          ? 'Claude Code Chrome access is enabled.\n'
          : 'Claude Code Chrome access is disabled.\n',
      );
      return 0;
    }
    if (argument !== 'enable' && argument !== 'disable') {
      process.stderr.write(
        'Usage: sorema chrome enable | sorema chrome disable | sorema chrome status\n',
      );
      return 1;
    }

    const enabled = argument === 'enable';
    writeClaudeChromeAccess(stateDirectory(), enabled);
    process.env.CLAUDE_CODE_CHROME_ENABLED = enabled ? 'true' : 'false';
    process.stdout.write(
      enabled
        ? 'Claude Code Chrome access enabled. Browser tasks may reach sites signed in on this machine.\n'
        : 'Claude Code Chrome access disabled.\n',
    );

    const { planService, isServiceInstalled, restartService } = await import('./service.js');
    const plan = planService(
      process.execPath,
      [process.argv[1], 'start'].filter((value): value is string => Boolean(value)),
    );
    if (isServiceInstalled(plan)) {
      restartService(plan);
      process.stdout.write('Restarted Sorema, so the change is active now.\n');
    } else {
      process.stdout.write('The setting will apply the next time Sorema starts.\n');
    }
    return 0;
  }

  if (command === 'projects') {
    // Read off argv rather than the single `argument` above: more than one folder is a reasonable
    // thing to have, and taking only the first would silently drop the rest.
    const requested = process.argv.slice(3);
    if (requested.length === 0) {
      const roots = readWorkspaceRoots(stateDirectory());
      if (roots.length === 0) {
        process.stdout.write(
          'No folder is set, so this machine offers no projects.\nRun: sorema projects <FOLDER>\n',
        );
        return 1;
      }
      for (const root of roots) {
        // A root that has since been moved or deleted is named as such. Somebody whose projects
        // moved sees why the machine went empty instead of assuming pairing broke.
        const problem = describeWorkspaceRootProblem(root);
        process.stdout.write(`${root}${problem ? ` — ${problem}` : ''}\n`);
      }
      return 0;
    }

    // Every folder is checked before any of them is stored: half-applying this would leave the
    // machine pointed at a list nobody asked for.
    const chosen: string[] = [];
    for (const value of requested) {
      const expanded = expandWorkspaceRoot(value);
      // Both, because the resolved path no longer shows what the person typed: a shell that ate the
      // backslashes leaves a plausible-looking absolute path pointing somewhere they never named.
      const problem = describeWorkspaceRootProblem(expanded, value);
      if (problem) {
        process.stderr.write(`Not changing anything: ${problem}.\n`);
        return 1;
      }
      chosen.push(expanded);
    }
    applyWorkspaceRoots(chosen);
    process.stdout.write(`Your projects are the folders in ${chosen.join(', ')}.\n`);

    const { planService, isServiceInstalled, restartService } = await import('./service.js');
    const plan = planService(
      process.execPath,
      [process.argv[1], 'start'].filter((value): value is string => Boolean(value)),
    );
    // Without this the answer takes effect at the next logon. The service read the roots when it
    // started and has no reason to read them again, so the folder changes and nothing happens —
    // which is indistinguishable from the command having ignored it.
    if (isServiceInstalled(plan)) {
      restartService(plan);
      process.stdout.write('Restarted it, so it looks there now.\n');
    }
    return 0;
  }

  if (command === 'pair') {
    if (!argument) {
      process.stderr.write('Which code? Get one from the web app, under "Pair your computer".\n');
      return 1;
    }
    if (identity.isPaired) {
      process.stderr.write(
        `Already paired as ${identity.deviceId}.\nDelete ${join(stateDirectory(), 'device-identity.json')} to pair again.\n`,
      );
      return 0;
    }

    const { pairWithCode } = await import('../../apps/local-agent/src/tunnel/cloud-pairing.js');
    const paired = await pairWithCode(
      String(process.env.SOREMA_API_URL),
      argument,
      identity,
      String(process.env.LOCAL_AGENT_DEVICE_NAME),
    );
    process.stdout.write(`Paired as ${paired.deviceId}.\n`);
    // The one moment somebody is certainly sitting at the terminal. Skipped when it has already been
    // answered, so re-running this never quietly reopens a decision that was made.
    if (readWorkspaceRoots(stateDirectory()).length === 0) await chooseWorkspaceRoots();
    process.stdout.write('Now run: sorema start\n');
    return 0;
  }

  if (command === 'start') {
    if (!identity.isPaired) {
      process.stderr.write('This machine is not paired yet. Run: sorema pair <CODE>\n');
      return 1;
    }
    const { runAgent } = await import('../../apps/local-agent/src/run.js');
    await runAgent();
    return 0;
  }

  if (command === 'service') {
    const { planService, installService, uninstallService, findRottingPath } =
      await import('./service.js');
    // Resolved now rather than written as `npx sorema`: `process.execPath` is the node binary and
    // argv[1] this script, so the service points at files that exist instead of at a temporary
    // directory npm is free to clear.
    const plan = planService(
      process.execPath,
      [process.argv[1], 'start'].filter((value): value is string => Boolean(value)),
    );

    if (argument === 'install') {
      if (!identity.isPaired) {
        process.stderr.write('Pair this machine first: sorema pair <CODE>\n');
        return 1;
      }
      const rotting = findRottingPath(process.execPath, [process.argv[1] ?? '']);
      if (rotting) {
        process.stderr.write(
          `Not installing: ${rotting}.
A service pointing there stops working without saying so. ` +
            `Install it properly first:

  npm install -g sorema

then run sorema service install again.
`,
        );
        return 1;
      }
      installService(plan);
      process.stdout.write(`Installed. Sorema now runs under ${plan.describe}.\n`);
      return 0;
    }
    if (argument === 'uninstall') {
      uninstallService(plan);
      process.stdout.write('Removed. Sorema no longer starts on its own.\n');
      return 0;
    }
    process.stderr.write('Usage: sorema service install | sorema service uninstall\n');
    return 1;
  }

  process.stderr.write(`No command called ${command}.\n\n${USAGE}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
