import { hostname, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

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

const VERSION = '0.4.1';

const USAGE = `sorema — run work on this machine, by voice, from anywhere.

  sorema <CODE>              Do everything: pair, install, connect. Run it again any time.
  sorema pair <CODE>         Claim the code shown in the web app. Once per machine.
  sorema start               Stay connected. Leave it running.
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
  const directory = join(homedir(), '.sorema');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function applyDefaults(): void {
  if (DEFAULT_API_URL) process.env.SOREMA_API_URL ??= DEFAULT_API_URL;
  if (DEFAULT_TUNNEL_URL) process.env.SOREMA_TUNNEL_URL ??= DEFAULT_TUNNEL_URL;
  process.env.SOREMA_STATE_DIR ??= stateDirectory();
  process.env.SOREMA_DATABASE_URL ??= `file:${join(stateDirectory(), 'sorema.sqlite')}`;
  process.env.SOREMA_DEVICE_NAME ??= `${hostname()} (${platform()})`;
  // Off by default: somebody who installed this wants it to do the work, not to mime it.
  process.env.SOREMA_DEMO_MODE ??= 'false';
}

async function main(): Promise<number> {
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
  const looksLikeCode = command !== undefined && /^[0-9a-fA-F]{8}$/.test(command);
  if (!command || looksLikeCode) {
    const { planService, installService, isServiceInstalled, findRottingPath, installGlobally } =
      await import('./service.js');
    const { planSetup } = await import('./setup.js');

    let argv = [process.argv[1], 'start'].filter((value): value is string => Boolean(value));
    let plan = planService(process.execPath, argv);
    const steps = planSetup({
      paired: identity.isPaired,
      code: looksLikeCode ? command : null,
      rottingPath: findRottingPath(process.execPath, argv),
      serviceInstalled: isServiceInstalled(plan),
    });

    for (const step of steps) {
      if (step.action === 'explain') process.stdout.write(`${step.message}\n`);
      if (step.action === 'pair') {
        const { pairWithCode } = await import('../../apps/local-agent/src/tunnel/cloud-pairing.js');
        const paired = await pairWithCode(
          String(process.env.SOREMA_API_URL),
          step.code,
          identity,
          String(process.env.SOREMA_DEVICE_NAME),
        );
        process.stdout.write(`Paired as ${paired.deviceId}.\n`);
      }
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
      if (step.action === 'already-running') {
        process.stdout.write('This machine is connected. Go and talk to it.\n');
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
      String(process.env.SOREMA_DEVICE_NAME),
    );
    process.stdout.write(`Paired as ${paired.deviceId}.\nNow run: sorema start\n`);
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
