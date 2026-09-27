import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  isExactReleaseVersion,
  type AgentRelease,
} from '../../apps/local-agent/src/release/agent-release.js';
import { isServiceInstalled, npmCommand, planService, type Runner } from './service.js';

export const PUBLISHED_PACKAGE_NAME = 'sorema';
export const LATEST_RELEASE_URL = `https://registry.npmjs.org/${PUBLISHED_PACKAGE_NAME}/latest`;
export const REPLACED_PROCESS_ID_VARIABLE = 'SOREMA_REPLACED_PROCESS_ID';
export const REPLACEMENT_READY_PATH_VARIABLE = 'SOREMA_REPLACEMENT_READY_PATH';

const REGISTRY_TIMEOUT_MS = 8_000;
const REPLACEMENT_READY_TIMEOUT_MS = 180_000;
const REPLACED_PROCESS_EXIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const WINDOWS_CONSOLE_RELAY_SCRIPT = [
  'const [program, ...programArguments] = process.argv.slice(1);',
  "const child = require('node:child_process').spawn(program, programArguments, { windowsHide: true, stdio: 'ignore' });",
  'child.on("exit", (code) => process.exit(code ?? 1));',
  'child.on("error", () => process.exit(1));',
].join(' ');

type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;
export type NpmRunner = (args: readonly string[]) => Promise<string>;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function fetchLatestPublishedVersion(
  fetchImplementation: FetchImplementation = (input, init) => fetch(input, init),
): Promise<string> {
  const response = await fetchImplementation(LATEST_RELEASE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The registry answered ${response.status}`);
  const manifest = (await response.json()) as { version?: unknown };
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!isExactReleaseVersion(version)) {
    throw new Error(
      `The registry named ${JSON.stringify(version)}, which is not a release version`,
    );
  }
  return version;
}

export function replacementArguments(originalArguments: readonly string[]): string[] {
  return originalArguments[0] === 'start' ? [...originalArguments] : ['start'];
}

export function findNpxEntryPoint(
  nodeExecutable: string,
  system: string = platform(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  const nodeDirectory = dirname(nodeExecutable);
  const candidate =
    system === 'win32'
      ? join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      : join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return exists(candidate) ? candidate : null;
}

export type ReplacementLaunchPlan = { program: string; args: string[] };

export function planReplacementLaunch(request: {
  system: string;
  nodeExecutable: string;
  npxEntryPoint: string | null;
  packageSpecifier: string;
  argumentsToReplay: readonly string[];
}): ReplacementLaunchPlan {
  const npxArguments = ['-y', request.packageSpecifier, ...request.argumentsToReplay];
  if (request.system === 'win32') {
    if (!request.npxEntryPoint) {
      throw new Error(`Could not find npx beside ${request.nodeExecutable}`);
    }
    return {
      program: request.nodeExecutable,
      args: [
        '-e',
        WINDOWS_CONSOLE_RELAY_SCRIPT,
        request.nodeExecutable,
        request.npxEntryPoint,
        ...npxArguments,
      ],
    };
  }
  if (!request.npxEntryPoint) return { program: 'npx', args: npxArguments };
  return { program: request.nodeExecutable, args: [request.npxEntryPoint, ...npxArguments] };
}

export type ReplacementRequest = {
  packageSpecifier: string;
  expectedVersion: string;
  argumentsToReplay: readonly string[];
  environment: NodeJS.ProcessEnv;
  readyDirectory: string;
  replacedProcessId: number;
  readyTimeoutMs?: number;
  nodeExecutable?: string;
  system?: string;
};

function stopReplacement(child: ChildProcess, system: string): void {
  try {
    if (system !== 'win32' && child.pid) process.kill(-child.pid);
    else child.kill();
  } catch {
    child.kill();
  }
}

export async function startReplacement(request: ReplacementRequest): Promise<void> {
  const system = request.system ?? platform();
  const nodeExecutable = request.nodeExecutable ?? process.execPath;
  const launch = planReplacementLaunch({
    system,
    nodeExecutable,
    npxEntryPoint: findNpxEntryPoint(nodeExecutable, system),
    packageSpecifier: request.packageSpecifier,
    argumentsToReplay: request.argumentsToReplay,
  });
  const readyPath = join(request.readyDirectory, `replacement-${randomUUID()}.ready`);
  const child = spawn(launch.program, launch.args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...request.environment,
      [REPLACED_PROCESS_ID_VARIABLE]: String(request.replacedProcessId),
      [REPLACEMENT_READY_PATH_VARIABLE]: readyPath,
    },
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  let exitDescription: string | null = null;
  child.once('exit', (code, signal) => {
    exitDescription = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
  });
  child.unref();

  const deadline = Date.now() + (request.readyTimeoutMs ?? REPLACEMENT_READY_TIMEOUT_MS);
  try {
    while (!existsSync(readyPath)) {
      if (exitDescription !== null) {
        throw new Error(`The replacement exited with ${exitDescription} before it was running`);
      }
      if (Date.now() > deadline) {
        stopReplacement(child, system);
        throw new Error('The replacement did not start in time');
      }
      await pause(POLL_INTERVAL_MS);
    }
    const reportedVersion = readFileSync(readyPath, 'utf8').trim();
    if (reportedVersion !== request.expectedVersion) {
      stopReplacement(child, system);
      throw new Error(`The replacement runs ${reportedVersion}, not ${request.expectedVersion}`);
    }
  } finally {
    rmSync(readyPath, { force: true });
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function takeOverFromReplacedProcess(
  environment: NodeJS.ProcessEnv,
  version: string,
  timeoutMs: number = REPLACED_PROCESS_EXIT_TIMEOUT_MS,
): Promise<void> {
  const replacedProcessId = Number.parseInt(environment[REPLACED_PROCESS_ID_VARIABLE] ?? '', 10);
  const readyPath = environment[REPLACEMENT_READY_PATH_VARIABLE];
  delete environment[REPLACED_PROCESS_ID_VARIABLE];
  delete environment[REPLACEMENT_READY_PATH_VARIABLE];
  if (!readyPath || !Number.isSafeInteger(replacedProcessId) || replacedProcessId <= 0) return;

  const partialPath = `${readyPath}.partial`;
  writeFileSync(partialPath, version, 'utf8');
  renameSync(partialPath, readyPath);

  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(replacedProcessId) && Date.now() < deadline) {
    await pause(POLL_INTERVAL_MS);
  }
}

export function isRunningAsInstalledService(
  executable: string,
  scriptArguments: readonly string[],
  options: { system?: string; home?: string; runner?: Runner } = {},
): boolean {
  const plan = planService(
    executable,
    scriptArguments,
    options.system ?? platform(),
    options.home ?? homedir(),
  );
  try {
    if (readFileSync(plan.path, plan.encoding) !== plan.contents) return false;
    if (
      plan.launcher &&
      readFileSync(plan.launcher.path, plan.launcher.encoding) !== plan.launcher.contents
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return options.runner ? isServiceInstalled(plan, options.runner) : isServiceInstalled(plan);
}

const execFileAsync = promisify(execFile);

async function runNpm(args: readonly string[]): Promise<string> {
  const [program, ...prefix] = npmCommand();
  const { stdout } = await execFileAsync(program ?? 'npm', [...prefix, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

function samePath(left: string, right: string): boolean {
  const normalise = (path: string) =>
    platform() === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalise(left) === normalise(right);
}

export async function installPublishedVersionForService(
  version: string,
  runningScript: string,
  npm: NpmRunner = runNpm,
): Promise<void> {
  if (!isExactReleaseVersion(version)) throw new Error(`${version} is not a release version`);
  const globalRoot = (await npm(['root', '--global'])).trim();
  const installedDirectory = join(globalRoot, PUBLISHED_PACKAGE_NAME);
  const installedScript = join(installedDirectory, 'dist', 'sorema.mjs');
  if (!samePath(installedScript, runningScript)) {
    throw new Error(`The service runs ${runningScript}, a copy npm does not manage`);
  }
  await npm(['install', '--global', `${PUBLISHED_PACKAGE_NAME}@${version}`]);
  const installed = JSON.parse(readFileSync(join(installedDirectory, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (installed.version !== version) {
    throw new Error(`npm left ${String(installed.version)} installed, not ${version}`);
  }
}

export function publishedAgentRelease(launch: {
  executable: string;
  scriptArguments: readonly string[];
  launchEnvironment: NodeJS.ProcessEnv;
  stateDirectory: string;
}): AgentRelease {
  return {
    fetchLatestVersion: () => fetchLatestPublishedVersion(),
    prepareReplacement: async (version) => {
      if (!isExactReleaseVersion(version)) throw new Error(`${version} is not a release version`);
      const [runningScript, ...commandArguments] = launch.scriptArguments;
      if (isRunningAsInstalledService(launch.executable, launch.scriptArguments)) {
        await installPublishedVersionForService(version, runningScript ?? '');
        return;
      }
      await startReplacement({
        packageSpecifier: `${PUBLISHED_PACKAGE_NAME}@${version}`,
        expectedVersion: version,
        argumentsToReplay: replacementArguments(commandArguments),
        environment: launch.launchEnvironment,
        readyDirectory: launch.stateDirectory,
        replacedProcessId: process.pid,
        nodeExecutable: launch.executable,
      });
    },
  };
}
