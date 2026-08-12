import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

const WORKSPACE_MARKER_FILE = 'pnpm-workspace.yaml';

export function findWorkspaceRoot(startDirectory: string = process.cwd()): string {
  let current = resolve(startDirectory);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, WORKSPACE_MARKER_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDirectory);
}

export function resolveFromWorkspaceRoot(relativeOrAbsolutePath: string): string {
  return resolve(findWorkspaceRoot(), relativeOrAbsolutePath);
}

/**
 * Where a running agent publishes its process id.
 *
 * Two halves need this path and neither owns the other: the agent writes it once it holds the
 * loopback port, and the installer reads it to stop that agent on a platform whose service manager
 * will not. Named once because a path restated in two places drifts, and the way it would fail is a
 * stop that silently stops nothing.
 */
export function agentProcessIdPath(stateDirectory: string): string {
  return resolve(stateDirectory, 'agent.pid');
}

let dotenvLoaded = false;

export function loadEnvironmentFiles(startDirectory: string = process.cwd()): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const rootDirectory = findWorkspaceRoot(startDirectory);
  for (const candidate of ['.env.local', '.env']) {
    const absolutePath = resolve(rootDirectory, candidate);
    if (existsSync(absolutePath)) loadDotenvFile({ path: absolutePath });
  }
}

const booleanFromString = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const commaSeparatedList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

export const localAgentConfigSchema = z.object({
  nodeEnvironment: z.enum(['development', 'test', 'production']).default('development'),
  /** The deployed tunnel. Empty means the agent has nowhere to connect and only serves loopback. */
  cloudTunnelUrl: z.string().default(''),
  loopbackHost: z.string().default('127.0.0.1'),
  loopbackPort: z.coerce.number().int().nonnegative().default(8788),
  stateDirectory: z.string().default('./.local-agent'),
  databaseUrl: z.string().default('file:./.local-agent/local-agent.sqlite'),
  deviceName: z.string().default('local-workstation'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  demoMode: z.boolean().default(false),
  allowedWorkspaceRoots: z.array(z.string()).default([]),
  codexExecutablePath: z.string().default('codex'),
  codexSandboxMode: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write'),
  claudeCodeExecutablePath: z.string().default('claude'),
  // Browser control materially expands what a coding task can reach. It must be an explicit opt-in
  // and the provider still checks that the installed Claude CLI actually supports the flag.
  claudeCodeChromeEnabled: z.boolean().default(false),
  jobTimeoutMs: z.coerce.number().int().positive().default(900_000),
  // A DynamoDB item cannot exceed 400 KB, and a job summary is one attribute of one item. Anything
  // larger than this and the write that reports a finished job fails, losing the result.
  maxJobOutputBytes: z.coerce.number().int().positive().max(120_000).default(60_000),
  reconnectInitialDelayMs: z.coerce.number().int().positive().default(500),
  reconnectMaxDelayMs: z.coerce.number().int().positive().default(30_000),
});

export type LocalAgentConfig = z.infer<typeof localAgentConfigSchema>;

export function loadLocalAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAgentConfig {
  return localAgentConfigSchema.parse({
    nodeEnvironment: environment.NODE_ENV,
    cloudTunnelUrl: environment.SOREMA_TUNNEL_URL,
    loopbackHost: environment.LOCAL_AGENT_HOST,
    loopbackPort: environment.LOCAL_AGENT_PORT,
    stateDirectory: environment.LOCAL_AGENT_STATE_DIR,
    databaseUrl: environment.LOCAL_AGENT_DATABASE_URL,
    deviceName: environment.LOCAL_AGENT_DEVICE_NAME,
    logLevel: environment.LOG_LEVEL,
    demoMode: booleanFromString.parse(environment.SOREMA_DEMO_MODE),
    allowedWorkspaceRoots: commaSeparatedList.parse(environment.LOCAL_AGENT_WORKSPACE_ROOTS),
    codexExecutablePath: environment.CODEX_EXECUTABLE_PATH,
    codexSandboxMode: environment.CODEX_SANDBOX_MODE,
    claudeCodeExecutablePath: environment.CLAUDE_CODE_EXECUTABLE_PATH,
    claudeCodeChromeEnabled: booleanFromString.parse(environment.CLAUDE_CODE_CHROME_ENABLED),
    jobTimeoutMs: environment.LOCAL_AGENT_JOB_TIMEOUT_MS,
    maxJobOutputBytes: environment.LOCAL_AGENT_MAX_JOB_OUTPUT_BYTES,
    reconnectInitialDelayMs: environment.LOCAL_AGENT_RECONNECT_INITIAL_DELAY_MS,
    reconnectMaxDelayMs: environment.LOCAL_AGENT_RECONNECT_MAX_DELAY_MS,
  });
}

export function resolveSqliteFilePath(databaseUrl: string): string {
  const withoutScheme = databaseUrl.startsWith('file:')
    ? databaseUrl.slice('file:'.length)
    : databaseUrl;
  return resolveFromWorkspaceRoot(withoutScheme);
}
