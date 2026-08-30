import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
  ExistingCodingSession,
  ListExistingCodingSessionsInput,
  ProviderDetectionResult,
  ResumeCodingSessionInput,
  SendCodingTaskInput,
} from '../provider-types.js';
import { parseSupportedFlags, buildSpokenSummary } from './codex-cli-provider.js';
import { readClaudeSessionsForProject } from './claude-session-store.js';

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
        },
      };
      return this.detectionCache;
    }

    this.supportedFlags = parseSupportedFlags(await this.runForOutput(['--help']));
    const canRunNonInteractively =
      this.supportedFlags.has('--print') && this.supportedFlags.has('--output-format');
    const authStatus = parseClaudeAuthStatus(
      await this.runForOutput(['auth', 'status', '--json'], true),
    );
    const authenticated = authStatus?.loggedIn !== false;
    // An installation that cannot be told what to leave alone is not an installation this can use.
    // It belongs in the detection rather than only in the refusal at job start, because this is
    // what the capability report carries and what the assistant reads before it offers the provider
    // out loud: otherwise it announces a provider it will then decline to run.
    const canBeToldWhatToLeaveAlone = this.supportedFlags.has('--disallowed-tools');
    const usable = canRunNonInteractively && authenticated && canBeToldWhatToLeaveAlone;

    this.detectionCache = {
      providerId: this.providerId,
      available: usable,
      status: usable ? 'ready' : 'misconfigured',
      version: version.trim(),
      details: {
        authenticated: authStatus?.loggedIn ?? 'unknown',
        ...(authStatus?.loggedIn === false ? { setupCommand: 'claude auth login' } : {}),
        ...(canBeToldWhatToLeaveAlone
          ? {}
          : {
              setupCommand: 'npm install -g @anthropic-ai/claude-code@latest',
              unavailableReason:
                'This Claude Code is too old to be told which tools to leave alone. Update it.',
            }),
        supportsDenyList: canBeToldWhatToLeaveAlone,
        supportsResume: this.supportedFlags.has('--resume'),
        supportsPreassignedSessionId: this.supportedFlags.has('--session-id'),
        supportsPermissionMode: this.supportedFlags.has('--permission-mode'),
        sandbox: 'working directory only, no operating-system sandbox',
      },
    };
    return this.detectionCache;
  }

  /**
   * What Claude Code already has for this project, read from its own transcript directory.
   *
   * There is no equivalent of the Codex app-server here, so the store is read directly; `--resume`
   * only finds a session when it is run from that session's own working directory, which is where
   * `sendTask` already runs, so an id from this list is one this provider can use.
   */
  async listExistingSessions(
    input: ListExistingCodingSessionsInput,
  ): Promise<ExistingCodingSession[]> {
    try {
      return readClaudeSessionsForProject({
        projectPath: input.projectPath,
        homeDirectory: homedir(),
        limit: input.limit,
      });
    } catch (error) {
      this.options.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'claude code could not list the sessions it already has',
      );
      return [];
    }
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
    // The same refusal Codex makes for itself, made here because Claude Code does not.
    //
    // Everything that undoes a job gone wrong is the user's own git history: the instruction that
    // reached the agent came through speech recognition that gets between forty and sixty per cent
    // of words right, so acting on the wrong one is not a remote possibility. In a repository that
    // is recoverable. In a plain folder it is a deletion and nothing else, and the recovery story
    // this product tells would have been true for one provider and false for the other.
    if (!existsSync(join(input.session.projectPath, '.git'))) {
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'PROJECT_NOT_ALLOWED',
          'the project folder is not a git repository',
          {
            userMessage:
              'That folder is not a git repository, so there would be no way to undo what the ' +
              'agent changes. Run git init in it, then ask again.',
            details: { projectPath: input.session.projectPath },
          },
        ),
      });
      // The same shape the missing-executable refusal above returns: the failure reaches the
      // caller through onUpdate, and this value only says a job object was made.
      return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
    }

    // The deny list is the only thing standing between this run and the actions local git history
    // cannot undo: a push, a publish, a request to somewhere else. A CLI too old to advertise the
    // flag is reported unavailable by `detect`, so this one refusal covers it, and it repeats the
    // reason detection gave rather than the generic one, which would send somebody reinstalling a
    // tool they already have.
    const detection = await this.detect();
    if (!detection.available) {
      const reason = detection.details?.unavailableReason;
      input.onUpdate({
        kind: 'failed',
        error: createStructuredError(
          'CODING_PROVIDER_NOT_INSTALLED',
          'Claude Code is not available on this device',
          {
            ...(typeof reason === 'string' ? { userMessage: reason } : {}),
            details: {
              executablePath: this.options.executablePath,
              ...(detection.details?.setupCommand !== undefined
                ? { setupCommand: detection.details.setupCommand }
                : {}),
            },
          },
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

    // Codex gets both of these from its own design: an operating-system sandbox that denies the
    // network, and a refusal to run outside a git repository. Claude Code has neither, so the one
    // that can be asked for is asked for here. Nothing on this list can be undone by local history:
    // a push reaches collaborators, a publish reaches a registry, a request reaches whoever is
    // listening. A job that needs one of them says so and waits for somebody at the keyboard.
    if (flags.has('--disallowed-tools')) {
      args.push(
        '--disallowed-tools',
        [
          'WebFetch',
          'WebSearch',
          'Bash(git push:*)',
          'Bash(git remote:*)',
          'Bash(npm publish:*)',
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(ssh:*)',
          'Bash(scp:*)',
        ].join(' '),
      );
    }

    // No `--chrome`, and no way to ask for it. Everything else a job does here is undone by the
    // user's own git history; a browser acting through their signed-in profile is the one thing that
    // is not, and this product has no way to put an email back.

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

  private runForOutput(args: string[], acceptNonZero = false): Promise<string | null> {
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
          finish(code === 0 || (acceptNonZero && output.trim().length > 0) ? output : null);
        });
      } catch {
        finish(null);
      }
    });
  }
}

function parseClaudeAuthStatus(value: string | null): { loggedIn: boolean } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? { loggedIn: parsed.loggedIn } : null;
  } catch {
    return null;
  }
}
