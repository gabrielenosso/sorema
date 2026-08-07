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

export const gatewayConfigSchema = z.object({
  nodeEnvironment: z.enum(['development', 'test', 'production']).default('development'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().nonnegative().default(8787),
  publicBaseUrl: z.string().default('http://localhost:8787'),
  databaseUrl: z.string().default('file:./data/gateway.sqlite'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  demoMode: z.boolean().default(false),
  singleUserId: z.string().default('user_local'),
  singleUserDisplayName: z.string().default('Local User'),
  clientAccessToken: z
    .string()
    // This single token is the only thing between the public internet and code execution on the
    // user's machine, so a short or guessable one is not a warning, it is a refusal to start.
    .min(32, 'SOREMA_CLIENT_TOKEN must be at least 32 characters')
    .refine(
      (value) => !/^(change-me|local-dev|test|example|secret)/i.test(value),
      'SOREMA_CLIENT_TOKEN is still a placeholder, generate a random one',
    ),
  deviceTokenSecret: z.string().min(16),
  deviceTokenTtlSeconds: z.coerce.number().int().positive().default(3600),
  openAiApiKey: z.string().default(''),
  openAiBaseUrl: z.string().default('https://api.openai.com/v1'),
  openAiRealtimeWebsocketUrl: z.string().default('wss://api.openai.com/v1/realtime'),
  realtimeModel: z.string().default('gpt-realtime-2.1'),
  realtimeVoice: z.string().default('marin'),
  realtimeTranscriptionModel: z.string().default(''),
  realtimeTurnDetection: z.enum(['semantic_vad', 'server_vad']).default('semantic_vad'),
  realtimeTurnEagerness: z.enum(['low', 'medium', 'high', 'auto']).default('low'),
  realtimeTurnSilenceMs: z.coerce.number().int().positive().default(900),
  realtimeAllowInterruption: z.boolean().default(true),
  toolTimeoutMs: z.coerce.number().int().positive().default(15_000),
  corsOrigins: z.array(z.string()).default([]),
  webClientOrigin: z.string().default('http://localhost:5173'),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return gatewayConfigSchema.parse({
    nodeEnvironment: environment.NODE_ENV,
    host: environment.GATEWAY_HOST,
    port: environment.GATEWAY_PORT,
    publicBaseUrl: environment.GATEWAY_PUBLIC_BASE_URL,
    databaseUrl: environment.GATEWAY_DATABASE_URL,
    logLevel: environment.LOG_LEVEL,
    demoMode: booleanFromString.parse(environment.SOREMA_DEMO_MODE),
    singleUserId: environment.SOREMA_USER_ID,
    singleUserDisplayName: environment.SOREMA_USER_NAME,
    clientAccessToken: environment.SOREMA_CLIENT_TOKEN,
    deviceTokenSecret: environment.SOREMA_DEVICE_TOKEN_SECRET,
    deviceTokenTtlSeconds: environment.SOREMA_DEVICE_TOKEN_TTL_SECONDS,
    openAiApiKey: environment.OPENAI_API_KEY,
    openAiBaseUrl: environment.OPENAI_BASE_URL,
    openAiRealtimeWebsocketUrl: environment.OPENAI_REALTIME_WEBSOCKET_URL,
    realtimeModel: environment.REALTIME_MODEL,
    realtimeVoice: environment.REALTIME_VOICE,
    realtimeTranscriptionModel: environment.REALTIME_TRANSCRIPTION_MODEL,
    realtimeTurnDetection: environment.REALTIME_TURN_DETECTION,
    realtimeTurnEagerness: environment.REALTIME_TURN_EAGERNESS,
    realtimeTurnSilenceMs: environment.REALTIME_TURN_SILENCE_MS,
    realtimeAllowInterruption:
      environment.REALTIME_ALLOW_INTERRUPTION === undefined
        ? true
        : environment.REALTIME_ALLOW_INTERRUPTION !== 'false',
    toolTimeoutMs: environment.TOOL_TIMEOUT_MS,
    corsOrigins: commaSeparatedList.parse(environment.GATEWAY_CORS_ORIGINS),
    webClientOrigin: environment.WEB_CLIENT_ORIGIN,
  });
}

export const localAgentConfigSchema = z.object({
  nodeEnvironment: z.enum(['development', 'test', 'production']).default('development'),
  gatewayTunnelUrl: z.string().default('ws://localhost:8787/api/local-agent/tunnel'),
  /**
   * The deployed tunnel. Set it and the agent talks to the cloud instead of a gateway on this
   * machine; leave it empty and nothing about the local setup changes.
   */
  cloudTunnelUrl: z.string().default(''),
  gatewayHttpUrl: z.string().default('http://localhost:8787'),
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
  jobTimeoutMs: z.coerce.number().int().positive().default(900_000),
  // A DynamoDB item cannot exceed 400 KB, and a job summary is one attribute of one item. Anything
  // larger than this and the write that reports a finished job fails, losing the result.
  maxJobOutputBytes: z.coerce.number().int().positive().max(120_000).default(60_000),
  reconnectInitialDelayMs: z.coerce.number().int().positive().default(500),
  reconnectMaxDelayMs: z.coerce.number().int().positive().default(30_000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(15_000),
  outboxFlushIntervalMs: z.coerce.number().int().positive().default(2_000),
});

export type LocalAgentConfig = z.infer<typeof localAgentConfigSchema>;

export function loadLocalAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAgentConfig {
  return localAgentConfigSchema.parse({
    nodeEnvironment: environment.NODE_ENV,
    gatewayTunnelUrl: environment.GATEWAY_TUNNEL_URL,
    cloudTunnelUrl: environment.SOREMA_TUNNEL_URL,
    gatewayHttpUrl: environment.GATEWAY_HTTP_URL,
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
    jobTimeoutMs: environment.LOCAL_AGENT_JOB_TIMEOUT_MS,
    maxJobOutputBytes: environment.LOCAL_AGENT_MAX_JOB_OUTPUT_BYTES,
    reconnectInitialDelayMs: environment.LOCAL_AGENT_RECONNECT_INITIAL_DELAY_MS,
    reconnectMaxDelayMs: environment.LOCAL_AGENT_RECONNECT_MAX_DELAY_MS,
    heartbeatIntervalMs: environment.LOCAL_AGENT_HEARTBEAT_INTERVAL_MS,
    outboxFlushIntervalMs: environment.LOCAL_AGENT_OUTBOX_FLUSH_INTERVAL_MS,
  });
}

export function resolveSqliteFilePath(databaseUrl: string): string {
  const withoutScheme = databaseUrl.startsWith('file:')
    ? databaseUrl.slice('file:'.length)
    : databaseUrl;
  return resolveFromWorkspaceRoot(withoutScheme);
}
