import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceIdentityStore } from '../../apps/local-agent/src/identity/device-identity-store.js';
import { installService, planService } from '../src/service.js';
import {
  fetchLatestPublishedVersion,
  installPublishedVersionForService,
  isRunningAsInstalledService,
  LATEST_RELEASE_URL,
  planReplacementLaunch,
  replacementArguments,
  REPLACED_PROCESS_ID_VARIABLE,
  REPLACEMENT_READY_PATH_VARIABLE,
  startReplacement,
  takeOverFromReplacedProcess,
} from '../src/self-update.js';

const BUNDLE = join(import.meta.dirname, '..', 'dist', 'sorema.mjs');
const BUILT_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const processesToStop: ChildProcess[] = [];
const processIdsToStop: number[] = [];

afterEach(() => {
  for (const child of processesToStop.splice(0)) child.kill();
  for (const processId of processIdsToStop.splice(0)) {
    try {
      process.kill(processId);
    } catch {
      continue;
    }
  }
});

function registryAnswering(status: number, body: unknown) {
  const requestedUrls: string[] = [];
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return { requestedUrls, fetchImplementation };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!address || typeof address === 'string') throw new Error('No local test port was assigned');
  return address.port;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function longRunningStandIn(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  processesToStop.push(child);
  return child;
}

function fixturePackage(binarySource: string | null, version: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'sorema-replacement-package-'));
  mkdirSync(join(directory, 'dist'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'sorema', version, bin: { sorema: 'dist/sorema.mjs' } }),
  );
  if (binarySource === null) copyFileSync(BUNDLE, join(directory, 'dist', 'sorema.mjs'));
  else
    writeFileSync(
      join(directory, 'dist', 'sorema.mjs'),
      `#!/usr/bin/env node
${binarySource}`,
    );
  return directory;
}

function isolatedEnvironment(stateDirectory: string, port: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: stateDirectory,
    HOME: stateDirectory,
    SOREMA_API_URL: 'https://example.invalid',
    SOREMA_TUNNEL_URL: 'wss://example.invalid',
    LOCAL_AGENT_STATE_DIR: stateDirectory,
    LOCAL_AGENT_DATABASE_URL: `file:${join(stateDirectory, 'sorema.sqlite')}`,
    LOCAL_AGENT_PORT: String(port),
  };
  delete environment.NODE_ENV;
  return environment;
}

async function healthVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

describe('reading the latest published version', () => {
  it('asks the public registry for exactly this package and returns its version', async () => {
    const registry = registryAnswering(200, { name: 'sorema', version: '0.9.21' });

    expect(await fetchLatestPublishedVersion(registry.fetchImplementation)).toBe('0.9.21');
    expect(registry.requestedUrls).toEqual([LATEST_RELEASE_URL]);
    expect(LATEST_RELEASE_URL).toBe('https://registry.npmjs.org/sorema/latest');
  });

  it.each(['0.9.21 && calc', 'https://attacker.example/sorema.tgz', '1.0.0-beta.1', 'latest', ''])(
    'refuses %j as something to install',
    async (version) => {
      const registry = registryAnswering(200, { version });

      await expect(fetchLatestPublishedVersion(registry.fetchImplementation)).rejects.toThrow();
    },
  );

  it('refuses an answer that is not a success', async () => {
    const registry = registryAnswering(503, { version: '0.9.21' });

    await expect(fetchLatestPublishedVersion(registry.fetchImplementation)).rejects.toThrow(/503/);
  });
});

describe('what the replacement is started with', () => {
  it('replays start, and never replays a pairing code', () => {
    expect(replacementArguments(['start'])).toEqual(['start']);
    expect(replacementArguments(['KQZM-W7PT'])).toEqual(['start']);
    expect(replacementArguments([])).toEqual(['start']);
  });

  it('on windows, starts npx through a relay so no console window can appear', () => {
    const launch = planReplacementLaunch({
      system: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npxEntryPoint: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
      packageSpecifier: 'sorema@0.9.21',
      argumentsToReplay: ['start'],
    });

    expect(launch.program).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(launch.args[0]).toBe('-e');
    expect(launch.args.slice(2)).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
      '-y',
      'sorema@0.9.21',
      'start',
    ]);
  });

  it('on windows, refuses rather than going through a shell when npx cannot be found', () => {
    expect(() =>
      planReplacementLaunch({
        system: 'win32',
        nodeExecutable: 'C:\\nodejs\\node.exe',
        npxEntryPoint: null,
        packageSpecifier: 'sorema@0.9.21',
        argumentsToReplay: ['start'],
      }),
    ).toThrow(/npx/);
  });

  it.each(['darwin', 'linux'])('on %s, runs npx directly', (system) => {
    expect(
      planReplacementLaunch({
        system,
        nodeExecutable: '/usr/local/bin/node',
        npxEntryPoint: '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
        packageSpecifier: 'sorema@0.9.21',
        argumentsToReplay: ['start'],
      }),
    ).toEqual({
      program: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/npm/bin/npx-cli.js', '-y', 'sorema@0.9.21', 'start'],
    });
    expect(
      planReplacementLaunch({
        system,
        nodeExecutable: '/usr/local/bin/node',
        npxEntryPoint: null,
        packageSpecifier: 'sorema@0.9.21',
        argumentsToReplay: ['start'],
      }),
    ).toEqual({ program: 'npx', args: ['-y', 'sorema@0.9.21', 'start'] });
  });
});

describe('taking over from the process being replaced', () => {
  it('does nothing when it is not a replacement', async () => {
    const environment: NodeJS.ProcessEnv = {};

    await takeOverFromReplacedProcess(environment, '0.9.21');

    expect(environment).toEqual({});
  });

  it('says it is running, then waits for the old process to be gone', async () => {
    const standIn = longRunningStandIn();
    const readyPath = join(mkdtempSync(join(tmpdir(), 'sorema-takeover-')), 'ready');
    const environment: NodeJS.ProcessEnv = {
      [REPLACED_PROCESS_ID_VARIABLE]: String(standIn.pid),
      [REPLACEMENT_READY_PATH_VARIABLE]: readyPath,
    };
    let tookOver = false;

    const takeOver = takeOverFromReplacedProcess(environment, '0.9.21').then(() => {
      tookOver = true;
    });
    await pause(1_000);

    expect(readFileSync(readyPath, 'utf8')).toBe('0.9.21');
    expect(tookOver).toBe(false);
    expect(environment[REPLACED_PROCESS_ID_VARIABLE]).toBeUndefined();
    expect(environment[REPLACEMENT_READY_PATH_VARIABLE]).toBeUndefined();

    standIn.kill();
    await takeOver;
    expect(tookOver).toBe(true);
  });
});

describe('a daemon started by the installed service', () => {
  const executable = '/usr/bin/node';
  const script = '/usr/lib/node_modules/sorema/dist/sorema.mjs';

  it.each(['darwin', 'linux', 'win32'])(
    'is recognised on %s when the service definition names exactly this process',
    (system) => {
      const home = mkdtempSync(join(tmpdir(), 'sorema-service-home-'));
      installService(planService(executable, [script, 'start'], system, home), () => {});

      expect(
        isRunningAsInstalledService(executable, [script, 'start'], {
          system,
          home,
          runner: () => {},
        }),
      ).toBe(true);
      expect(
        isRunningAsInstalledService(executable, ['/tmp/_npx/1/sorema.mjs', 'start'], {
          system,
          home,
          runner: () => {},
        }),
      ).toBe(false);
    },
  );

  it('is not recognised when the service manager does not know the service', () => {
    const home = mkdtempSync(join(tmpdir(), 'sorema-service-home-'));
    installService(planService(executable, [script, 'start'], 'linux', home), () => {});

    expect(
      isRunningAsInstalledService(executable, [script, 'start'], {
        system: 'linux',
        home,
        runner: () => {
          throw new Error('not registered');
        },
      }),
    ).toBe(false);
  });

  it('installs exactly the published version globally and checks what landed', async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), 'sorema-global-root-'));
    const runningScript = join(globalRoot, 'sorema', 'dist', 'sorema.mjs');
    const npmCalls: string[][] = [];
    const npm = async (args: readonly string[]): Promise<string> => {
      npmCalls.push([...args]);
      if (args[0] === 'root') return `${globalRoot}\n`;
      mkdirSync(join(globalRoot, 'sorema', 'dist'), { recursive: true });
      writeFileSync(
        join(globalRoot, 'sorema', 'package.json'),
        JSON.stringify({ version: '0.9.21' }),
      );
      return '';
    };

    await installPublishedVersionForService('0.9.21', runningScript, npm);

    expect(npmCalls).toContainEqual(['install', '--global', 'sorema@0.9.21']);
  });

  it('refuses when what landed is not the version asked for', async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), 'sorema-global-root-'));
    const npm = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'root') return globalRoot;
      mkdirSync(join(globalRoot, 'sorema'), { recursive: true });
      writeFileSync(
        join(globalRoot, 'sorema', 'package.json'),
        JSON.stringify({ version: '0.9.20' }),
      );
      return '';
    };

    await expect(
      installPublishedVersionForService(
        '0.9.21',
        join(globalRoot, 'sorema', 'dist', 'sorema.mjs'),
        npm,
      ),
    ).rejects.toThrow(/0\.9\.20/);
  });

  it('refuses when the service runs a copy that npm does not manage', async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), 'sorema-global-root-'));
    const npm = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'root') return globalRoot;
      mkdirSync(join(globalRoot, 'sorema'), { recursive: true });
      writeFileSync(
        join(globalRoot, 'sorema', 'package.json'),
        JSON.stringify({ version: '0.9.21' }),
      );
      return '';
    };

    await expect(
      installPublishedVersionForService('0.9.21', '/somewhere/else/sorema.mjs', npm),
    ).rejects.toThrow(/does not manage/);
  });
});

describe('starting the replacement through the real npx', () => {
  it('fails, and says so, when the replacement exits before it is running', async () => {
    const packageDirectory = fixturePackage('process.exit(3);\n', '0.9.21');

    await expect(
      startReplacement({
        packageSpecifier: packageDirectory,
        expectedVersion: '0.9.21',
        argumentsToReplay: ['start'],
        environment: process.env,
        readyDirectory: mkdtempSync(join(tmpdir(), 'sorema-ready-')),
        replacedProcessId: process.pid,
        readyTimeoutMs: 120_000,
      }),
    ).rejects.toThrow(/exited with code 3/);
  }, 150_000);

  it.skipIf(process.platform !== 'win32')(
    'puts no console window on the desktop, for it or for anything it starts',
    async () => {
      const workDirectory = mkdtempSync(join(tmpdir(), 'sorema-console-probe-'));
      const probePath = join(workDirectory, 'probe.ps1');
      const answerPath = join(workDirectory, 'answer.txt');
      writeFileSync(
        probePath,
        [
          'Add-Type -Namespace Sorema -Name Native -MemberDefinition @"',
          '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
          '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);',
          '"@',
          '$handle = [Sorema.Native]::GetConsoleWindow()',
          '$visible = $false',
          'if ($handle -ne [IntPtr]::Zero) { $visible = [Sorema.Native]::IsWindowVisible($handle) }',
          'Write-Output $visible',
        ].join('\n'),
      );
      const packageDirectory = fixturePackage(
        [
          "import { execFileSync } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(process.env.${REPLACEMENT_READY_PATH_VARIABLE}, '1.0.0');`,
          `const said = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(probePath)}], { encoding: 'utf8' }).trim();`,
          `writeFileSync(${JSON.stringify(answerPath)}, JSON.stringify({ processId: process.pid, visible: said === 'True' }));`,
          'setTimeout(() => {}, 20000);',
        ].join('\n'),
        '1.0.0',
      );

      await startReplacement({
        packageSpecifier: packageDirectory,
        expectedVersion: '1.0.0',
        argumentsToReplay: ['start'],
        environment: process.env,
        readyDirectory: workDirectory,
        replacedProcessId: process.pid,
        readyTimeoutMs: 120_000,
      });
      const deadline = Date.now() + 30_000;
      while (!existsSync(answerPath) && Date.now() < deadline) await pause(250);
      const answer = JSON.parse(readFileSync(answerPath, 'utf8')) as {
        processId: number;
        visible: boolean;
      };
      processIdsToStop.push(answer.processId);

      expect(answer.visible).toBe(false);
    },
    180_000,
  );

  it.skipIf(!existsSync(BUNDLE))(
    'hands over to the new daemon, which starts only once the old one is gone',
    async () => {
      const stateDirectory = mkdtempSync(join(tmpdir(), 'sorema-replacement-state-'));
      new DeviceIdentityStore(stateDirectory).recordPairing('device-test', 'user-test');
      const port = await availablePort();
      const oldDaemon = longRunningStandIn();

      await startReplacement({
        packageSpecifier: fixturePackage(null, BUILT_VERSION),
        expectedVersion: BUILT_VERSION,
        argumentsToReplay: ['start'],
        environment: isolatedEnvironment(stateDirectory, port),
        readyDirectory: stateDirectory,
        replacedProcessId: oldDaemon.pid ?? 0,
        readyTimeoutMs: 120_000,
      });
      await pause(1_500);
      expect(await healthVersion(port)).toBeNull();

      oldDaemon.kill();
      const deadline = Date.now() + 30_000;
      let answered: string | null = null;
      while (answered === null && Date.now() < deadline) {
        await pause(250);
        answered = await healthVersion(port);
      }
      const processIdPath = join(stateDirectory, 'agent.pid');
      if (existsSync(processIdPath)) {
        processIdsToStop.push(Number.parseInt(readFileSync(processIdPath, 'utf8'), 10));
      }

      expect(answered).toBe(BUILT_VERSION);
    },
    180_000,
  );
});
