import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveExecutablePath,
  spawnResolvedExecutable,
} from '../../../process/executable-resolver.js';
import { createStructuredError, nowIsoTimestamp } from '@sorema/domain-model';
import { redactSecrets, truncateOutput } from '@sorema/security';
import type { Logger } from '@sorema/observability';
import { listCodexThreads } from './codex-app-server-client.js';
import { threadsToExistingSessions } from './codex-thread-listing.js';
import type {
  CodingJob,
  CodingJobStatus,
  CodingProvider,
  CodingSession,
  CreateCodingSessionInput,
  ExistingCodingSession,
  ListExistingCodingSessionsInput,
  ProviderDetectionResult,
  ResumeCodingSessionInput,
  SendCodingTaskInput,
} from '../provider-types.js';

export const CODEX_PROVIDER_ID = 'codex';

const SESSION_ID_KEYS = ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findSessionIdentifier(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SESSION_ID_KEYS.includes(key) && typeof nested === 'string' && UUID_PATTERN.test(nested)) {
      return nested;
    }
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findSessionIdentifier(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

export function describeCodexEvent(event: Record<string, unknown>): string | null {
  const nested = (event.msg ?? event.item ?? {}) as Record<string, unknown>;
  const type = String(event.type ?? nested.type ?? '');
  const itemType = String(nested.item_type ?? nested.type ?? '');

  if (type.includes('command') || itemType.includes('command')) {
    const command = nested.command ?? (nested.parsed_cmd as Record<string, unknown> | undefined);
    return command ? `running ${truncateOutput(String(command), 120)}` : 'running a command';
  }
  if (type.includes('patch') || itemType.includes('patch') || itemType.includes('file_change')) {
    return 'editing files';
  }
  if (type.includes('reasoning')) return 'thinking about the change';
  if (type.includes('agent_message') || itemType === 'agent_message') return 'writing an update';
  if (type.includes('web_search')) return 'looking something up';
  return null;
}

type RunningProcess = {
  child: ChildProcessWithoutNullStreams;
  lastMessagePath: string;
  cancelled: boolean;
};

export type CodexCliProviderOptions = {
  executablePath: string;
  sandboxMode: string;
  stateDirectory: string;
  jobTimeoutMs: number;
  maxOutputBytes: number;
  logger: Logger;
  executableArguments?: readonly string[];
};

export class CodexCliProvider implements CodingProvider {
  readonly providerId = CODEX_PROVIDER_ID;

  private readonly options: CodexCliProviderOptions;
  private readonly runningProcesses = new Map<string, RunningProcess>();
  private detectionCache: ProviderDetectionResult | null = null;
  private supportedExecFlags = new Set<string>();
  private supportedResumeFlags = new Set<string>();

  constructor(options: CodexCliProviderOptions) {
    this.options = options;
  }

  async detect(): Promise<ProviderDetectionResult> {
    if (this.detectionCache) return this.detectionCache;
    const version = await this.runForOutput(['--version']);
    if (version === null) {
      this.detectionCache = {
        providerId: this.providerId,
        available: false,
        status: 'missing',
        details: { executablePath: this.options.executablePath },
      };
      return this.detectionCache;
    }

    this.supportedExecFlags = parseSupportedFlags(await this.runForOutput(['exec', '--help']));
    this.supportedResumeFlags = parseSupportedFlags(
      await this.runForOutput(['exec', 'resume', '--help']),
    );

    const canRunNonInteractively = this.supportedExecFlags.has('--json');
    this.detectionCache = {
      providerId: this.providerId,
      available: canRunNonInteractively,
      status: canRunNonInteractively ? 'ready' : 'misconfigured',
      version: version.trim(),
      details: {
        supportsResume: this.supportedResumeFlags.size > 0,
        supportsWorkingDirectoryFlag: this.supportedExecFlags.has('--cd'),
        supportsSandboxFlag: this.supportedExecFlags.has('--sandbox'),
      },
    };
    return this.detectionCache;
  }

  /**
   * What Codex already has for this project, including the sessions the person started in the
   * desktop application: the app and the CLI write to the same store, and `exec resume` takes an id
   * from either.
   *
   * A failure here is an empty list. This answers "what were you working on", and a person who has
   * never opened the desktop application should hear that there is nothing rather than an error
   * about a protocol they have never heard of.
   */
  async listExistingSessions(
    input: ListExistingCodingSessionsInput,
  ): Promise<ExistingCodingSession[]> {
    try {
      const threads = await listCodexThreads(
        {
          executablePath: this.options.executablePath,
          executableArguments: this.options.executableArguments,
        },
        { cwd: input.projectPath, limit: input.limit },
      );
      return threadsToExistingSessions(threads);
    } catch (error) {
      this.options.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'codex could not list the sessions it already has',
      );
      return [];
    }
  }

  async createSession(input: CreateCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      projectPath: input.projectPath,
      title: input.title,
      metadata: { createdAt: nowIsoTimestamp() },
    };
  }

  async resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: input.providerSessionId,
      projectPath: input.projectPath,
      title: input.title,
      metadata: { ...(input.metadata ?? {}), resumedAt: nowIsoTimestamp() },
    };
  }

  async sendTask(input: SendCodingTaskInput): Promise<CodingJob> {
    const detection = await this.detect();
    if (!detection.available) {
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'CODING_PROVIDER_NOT_INSTALLED',
          'Codex CLI is not available on this device',
          { details: { executablePath: this.options.executablePath } },
        ),
      });
      return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
    }

    mkdirSync(this.options.stateDirectory, { recursive: true });
    const lastMessagePath = join(this.options.stateDirectory, `${input.jobId}.last-message.txt`);
    const args = this.buildArguments(input, lastMessagePath);
    const resolvedExecutable = resolveExecutablePath(this.options.executablePath);

    if (!resolvedExecutable) {
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'CODING_PROVIDER_NOT_INSTALLED',
          'Codex CLI could not be resolved on this device',
        ),
      });
      return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
    }

    const child = spawnResolvedExecutable(resolvedExecutable, args, {
      cwd: input.session.projectPath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'error' },
    }) as ChildProcessWithoutNullStreams;

    child.stdin.on('error', () => undefined);
    child.stdin.end(input.instruction, 'utf8');

    const record: RunningProcess = { child, lastMessagePath, cancelled: false };
    this.runningProcesses.set(input.jobId, record);
    input.onUpdate({ kind: 'started', providerSessionId: input.session.providerSessionId });

    let discoveredSessionId = input.session.providerSessionId;
    let stdoutBuffer = '';
    let collectedStderr = '';
    let eventCount = 0;

    const timeoutTimer = setTimeout(() => {
      this.options.logger.warn(
        { jobId: input.jobId },
        'codex task exceeded the configured timeout',
      );
      record.cancelled = true;
      child.kill('SIGTERM');
    }, this.options.jobTimeoutMs);
    timeoutTimer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        eventCount += 1;
        if (!discoveredSessionId) {
          const found = findSessionIdentifier(event);
          if (found) {
            discoveredSessionId = found;
            input.onUpdate({ kind: 'session_identified', providerSessionId: found });
          }
        }
        const description = describeCodexEvent(event);
        if (description) {
          input.onUpdate({
            kind: 'progress',
            progress: Math.min(0.9, 0.1 + eventCount * 0.05),
            message: description,
          });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      collectedStderr = truncateOutput(collectedStderr + chunk, this.options.maxOutputBytes);
    });

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      this.runningProcesses.delete(input.jobId);
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'CODING_PROVIDER_NOT_INSTALLED',
          `Could not launch Codex CLI: ${error.message}`,
        ),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      this.runningProcesses.delete(input.jobId);
      const lastMessage = readLastMessage(lastMessagePath);

      if (record.cancelled) {
        input.onUpdate({
          kind: 'failed',
          error: createStructuredError('COMMAND_REJECTED', 'The coding task was stopped', {
            userMessage: 'I stopped the task. Some changes may already be on disk.',
          }),
        });
        return;
      }

      if (code === 0) {
        const summary = lastMessage ?? 'Codex finished the task without a closing message.';
        input.onUpdate({
          kind: 'completed',
          summary: redactSecrets(truncateOutput(summary, this.options.maxOutputBytes)),
          spokenSummary: buildSpokenSummary(redactSecrets(summary)),
          details: {
            providerSessionId: discoveredSessionId,
            exitCode: code,
          },
        });
        return;
      }

      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'INTERNAL_ERROR',
          `Codex exited with code ${code ?? 'unknown'}`,
          {
            retryable: true,
            userMessage: 'The coding agent stopped with an error before finishing.',
            details: { stderr: redactSecrets(collectedStderr).slice(-2000) },
          },
        ),
      });
    });

    return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
  }

  private buildArguments(input: SendCodingTaskInput, lastMessagePath: string): string[] {
    const resuming = Boolean(input.session.providerSessionId);
    const flags = resuming ? this.supportedResumeFlags : this.supportedExecFlags;
    const args = [
      ...(this.options.executableArguments ?? []),
      'exec',
      ...(resuming ? ['resume', String(input.session.providerSessionId)] : []),
    ];

    if (flags.has('--json')) args.push('--json');
    // Deliberately never passed. Codex refuses to run outside a git repository, and that refusal
    // is its whole answer to an agent that deletes something: the undo is the git history the user
    // already has. Passing the flag switched off somebody else safety design and put nothing in
    // its place, which is the difference between routing a mistake and causing one.
    if (flags.has('--output-last-message')) args.push('--output-last-message', lastMessagePath);
    if (flags.has('--cd')) args.push('--cd', input.session.projectPath);

    // `--sandbox` only exists on `codex exec`, not on `codex exec resume`, so relying on it alone
    // would let a resumed task silently inherit whatever sandbox_mode the user's global
    // config.toml sets. The `-c` override is accepted by both and always wins.
    if (flags.has('--config')) args.push('-c', `sandbox_mode="${this.options.sandboxMode}"`);
    else if (flags.has('--sandbox')) args.push('--sandbox', this.options.sandboxMode);

    args.push('-');
    return args;
  }

  async cancelTask(jobId: string): Promise<void> {
    const record = this.runningProcesses.get(jobId);
    if (!record) return;
    record.cancelled = true;
    record.child.kill('SIGTERM');
  }

  async getTaskStatus(jobId: string): Promise<CodingJobStatus> {
    return { jobId, running: this.runningProcesses.has(jobId) };
  }

  private runForOutput(args: string[]): Promise<string | null> {
    return new Promise((resolvePromise) => {
      let output = '';
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      const resolved = resolveExecutablePath(this.options.executablePath);
      if (!resolved) {
        finish(null);
        return;
      }
      try {
        const child = spawnResolvedExecutable(
          resolved,
          [...(this.options.executableArguments ?? []), ...args],
          { windowsHide: true },
        );
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          finish(null);
        }, 15_000);
        timer.unref?.();
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
        });
        child.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          finish(code === 0 ? output : null);
        });
      } catch {
        finish(null);
      }
    });
  }
}

export function parseSupportedFlags(helpText: string | null): Set<string> {
  if (!helpText) return new Set();
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)) {
    if (match[1]) flags.add(match[1]);
  }
  return flags;
}

function readLastMessage(path: string): string | null {
  try {
    const contents = readFileSync(path, 'utf8').trim();
    rmSync(path, { force: true });
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

export function buildSpokenSummary(summary: string): string {
  const firstParagraph = summary.split(/\n\s*\n/)[0] ?? summary;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 320) return collapsed;
  return `${collapsed.slice(0, 317)}...`;
}
