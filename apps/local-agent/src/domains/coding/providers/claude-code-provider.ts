import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createStructuredError, nowIsoTimestamp } from '@sorema/domain-model';
import { redactSecrets, truncateOutput } from '@sorema/security';
import type { Logger } from '@sorema/observability';
import {
  resolveExecutablePath,
  spawnResolvedExecutable,
} from '../../../process/executable-resolver.js';
import type {
  CodingJob,
  CodingJobStatus,
  CodingProvider,
  CodingSession,
  CreateCodingSessionInput,
  ProviderDetectionResult,
  ResumeCodingSessionInput,
  SendCodingTaskInput,
} from '../provider-types.js';
import { parseSupportedFlags, buildSpokenSummary } from './codex-cli-provider.js';

export const CLAUDE_CODE_PROVIDER_ID = 'claude';

export function describeClaudeEvent(event: Record<string, unknown>): string | null {
  const type = String(event.type ?? '');
  if (type === 'assistant') {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use') continue;
      const toolName = String(block.name ?? '');
      if (toolName === 'Bash') return 'running a command';
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        return 'editing files';
      }
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        return 'reading the project';
      }
      if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'looking something up';
      if (toolName === 'Task') return 'delegating part of the work';
      return `using ${toolName}`;
    }
    return 'writing an update';
  }
  if (type === 'user') return 'reading a tool result';
  return null;
}

export function extractClaudeResult(
  event: Record<string, unknown>,
): { summary: string; failed: boolean } | null {
  if (String(event.type ?? '') !== 'result') return null;
  const summary = String(event.result ?? '').trim();
  const failed = event.is_error === true || String(event.subtype ?? 'success') !== 'success';
  return { summary, failed };
}

type RunningProcess = {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
};

export type ClaudeCodeProviderOptions = {
  executablePath: string;
  /** Explicit user opt-in. Browser access remains off unless the installed CLI also supports it. */
  chromeEnabled?: boolean;
  stateDirectory: string;
  jobTimeoutMs: number;
  maxOutputBytes: number;
  logger: Logger;
  executableArguments?: readonly string[];
};

/**
 * Claude Code has no operating-system sandbox of its own, unlike Codex. Confinement here comes from
 * the working directory: Claude Code may only touch the directory it is started in plus anything
 * passed to `--add-dir`, and we pass neither anything extra nor `--dangerously-skip-permissions`.
 * `--permission-mode acceptEdits` lets it edit inside that workspace without prompting, which is
 * what a non-interactive run needs, while still refusing the operations that mode does not cover.
 */
export class ClaudeCodeProvider implements CodingProvider {
  readonly providerId = CLAUDE_CODE_PROVIDER_ID;

  private readonly options: ClaudeCodeProviderOptions;
  private readonly runningProcesses = new Map<string, RunningProcess>();
  private detectionCache: ProviderDetectionResult | null = null;
  private supportedFlags = new Set<string>();

  constructor(options: ClaudeCodeProviderOptions) {
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
        details: {
          executablePath: this.options.executablePath,
          supportsChrome: false,
          chromeAccessRequested: this.options.chromeEnabled === true,
          chromeAccessEnabled: false,
        },
      };
      return this.detectionCache;
    }

    this.supportedFlags = parseSupportedFlags(await this.runForOutput(['--help']));
    const canRunNonInteractively =
      this.supportedFlags.has('--print') && this.supportedFlags.has('--output-format');

    this.detectionCache = {
      providerId: this.providerId,
      available: canRunNonInteractively,
      status: canRunNonInteractively ? 'ready' : 'misconfigured',
      version: version.trim(),
      details: {
        supportsResume: this.supportedFlags.has('--resume'),
        supportsPreassignedSessionId: this.supportedFlags.has('--session-id'),
        supportsPermissionMode: this.supportedFlags.has('--permission-mode'),
        supportsChrome: this.supportedFlags.has('--chrome'),
        chromeAccessRequested: this.options.chromeEnabled === true,
        chromeAccessEnabled:
          this.options.chromeEnabled === true && this.supportedFlags.has('--chrome'),
        sandbox: 'working directory only, no operating-system sandbox',
      },
    };
    return this.detectionCache;
  }

  async createSession(input: CreateCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: randomUUID(),
      projectPath: input.projectPath,
      title: input.title,
      metadata: { createdAt: nowIsoTimestamp() },
    };
  }

  async resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: input.providerSessionId ?? randomUUID(),
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
          'Claude Code is not available on this device',
          { details: { executablePath: this.options.executablePath } },
        ),
      });
      return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
    }

    const resolvedExecutable = resolveExecutablePath(this.options.executablePath);
    if (!resolvedExecutable) {
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'CODING_PROVIDER_NOT_INSTALLED',
          'Claude Code could not be resolved on this device',
        ),
      });
      return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
    }

    const child = spawnResolvedExecutable(resolvedExecutable, this.buildArguments(input), {
      cwd: input.session.projectPath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    child.stdin.on('error', () => undefined);
    child.stdin.end(input.instruction, 'utf8');

    const record: RunningProcess = { child, cancelled: false };
    this.runningProcesses.set(input.jobId, record);
    input.onUpdate({ kind: 'started', providerSessionId: input.session.providerSessionId });

    let stdoutBuffer = '';
    let collectedStderr = '';
    let eventCount = 0;
    let terminalResult: { summary: string; failed: boolean } | null = null;

    const timeoutTimer = setTimeout(() => {
      this.options.logger.warn(
        { jobId: input.jobId },
        'claude code task exceeded the configured timeout',
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

        const result = extractClaudeResult(event);
        if (result) {
          terminalResult = result;
          continue;
        }

        const description = describeClaudeEvent(event);
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
          `Could not launch Claude Code: ${error.message}`,
        ),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      this.runningProcesses.delete(input.jobId);

      if (record.cancelled) {
        input.onUpdate({
          kind: 'failed',
          error: createStructuredError('COMMAND_REJECTED', 'The coding task was stopped', {
            userMessage: 'I stopped the task. Some changes may already be on disk.',
          }),
        });
        return;
      }

      const result: { summary: string; failed: boolean } | null = terminalResult;
      if (code === 0 && result !== null && !result.failed) {
        const summary =
          result.summary.length > 0
            ? result.summary
            : 'Claude Code finished the task without a closing message.';
        input.onUpdate({
          kind: 'completed',
          summary: redactSecrets(truncateOutput(summary, this.options.maxOutputBytes)),
          spokenSummary: buildSpokenSummary(redactSecrets(summary)),
          details: { providerSessionId: input.session.providerSessionId, exitCode: code },
        });
        return;
      }

      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'INTERNAL_ERROR',
          result?.failed === true
            ? `Claude Code reported a failure: ${redactSecrets(result.summary).slice(0, 300)}`
            : `Claude Code exited with code ${code ?? 'unknown'}`,
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

  private buildArguments(input: SendCodingTaskInput): string[] {
    const flags = this.supportedFlags;
    const args = [...(this.options.executableArguments ?? [])];
    const sessionId = input.session.providerSessionId;
    const resuming = Boolean(sessionId) && input.session.metadata?.resumedAt !== undefined;

    if (flags.has('--print')) args.push('--print');
    if (flags.has('--output-format')) args.push('--output-format', 'stream-json');
    if (flags.has('--verbose')) args.push('--verbose');

    if (sessionId) {
      if (resuming && flags.has('--resume')) args.push('--resume', sessionId);
      else if (flags.has('--session-id')) args.push('--session-id', sessionId);
    }

    // Deliberately no --dangerously-skip-permissions and no --add-dir: the working directory is the
    // only place this run may touch.
    if (flags.has('--permission-mode')) args.push('--permission-mode', 'acceptEdits');

    // Browser access is a separate authority boundary. A configuration opt-in alone is not enough:
    // only pass the flag when this exact installed CLI advertised support for it during detection.
    if (this.options.chromeEnabled === true && flags.has('--chrome')) args.push('--chrome');

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
