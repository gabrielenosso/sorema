import { createStructuredError, nowIsoTimestamp } from '@sorema/domain-model';
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

export const FAKE_PROVIDER_ID = 'fake';

type SimulatedStep = { progress: number; message: string };

const SIMULATED_STEPS: readonly SimulatedStep[] = [
  { progress: 0.2, message: 'reading the project structure' },
  { progress: 0.45, message: 'editing files' },
  { progress: 0.7, message: 'running the tests' },
  { progress: 0.9, message: 'writing a summary' },
];

export type FakeCodingProviderOptions = {
  stepDelayMs?: number;
  failInstructionPattern?: RegExp;
};

export class FakeCodingProvider implements CodingProvider {
  readonly providerId = FAKE_PROVIDER_ID;

  private readonly stepDelayMs: number;
  private readonly failInstructionPattern: RegExp;
  private readonly timersByJobId = new Map<string, NodeJS.Timeout[]>();
  private readonly cancelledJobIds = new Set<string>();
  private sessionCounter = 0;

  constructor(options: FakeCodingProviderOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 400;
    this.failInstructionPattern = options.failInstructionPattern ?? /\bfail on purpose\b/i;
  }

  async detect(): Promise<ProviderDetectionResult> {
    return {
      providerId: this.providerId,
      available: true,
      status: 'ready',
      version: 'simulated',
      details: { simulated: true },
    };
  }

  /** The demo provider keeps no store of its own, so there is never anything to carry on with. */
  async listExistingSessions(
    _input: ListExistingCodingSessionsInput,
  ): Promise<ExistingCodingSession[]> {
    return [];
  }

  async createSession(input: CreateCodingSessionInput): Promise<CodingSession> {
    this.sessionCounter += 1;
    return {
      providerId: this.providerId,
      providerSessionId: `fake-session-${this.sessionCounter}`,
      projectPath: input.projectPath,
      title: input.title,
      metadata: { simulated: true, createdAt: nowIsoTimestamp() },
    };
  }

  async resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: input.providerSessionId ?? `fake-session-${++this.sessionCounter}`,
      projectPath: input.projectPath,
      title: input.title,
      metadata: { ...(input.metadata ?? {}), simulated: true, resumedAt: nowIsoTimestamp() },
    };
  }

  async sendTask(input: SendCodingTaskInput): Promise<CodingJob> {
    this.cancelledJobIds.delete(input.jobId);
    const timers: NodeJS.Timeout[] = [];
    this.timersByJobId.set(input.jobId, timers);

    input.onUpdate({ kind: 'started', providerSessionId: input.session.providerSessionId });
    if (input.session.providerSessionId) {
      input.onUpdate({
        kind: 'session_identified',
        providerSessionId: input.session.providerSessionId,
      });
    }

    SIMULATED_STEPS.forEach((step, index) => {
      const timer = setTimeout(
        () => {
          if (this.cancelledJobIds.has(input.jobId)) return;
          input.onUpdate({ kind: 'progress', progress: step.progress, message: step.message });
        },
        this.stepDelayMs * (index + 1),
      );
      timer.unref?.();
      timers.push(timer);
    });

    const finalTimer = setTimeout(
      () => {
        this.timersByJobId.delete(input.jobId);
        if (this.cancelledJobIds.has(input.jobId)) {
          this.cancelledJobIds.delete(input.jobId);
          input.onUpdate({
            kind: 'failed',
            error: createStructuredError('COMMAND_REJECTED', 'The simulated task was stopped', {
              userMessage: 'I stopped the task.',
            }),
          });
          return;
        }
        if (this.failInstructionPattern.test(input.instruction)) {
          input.onUpdate({
            kind: 'failed',
            error: createStructuredError(
              'INTERNAL_ERROR',
              'Simulated failure requested by the instruction',
              { userMessage: 'The simulated task failed, as requested.' },
            ),
          });
          return;
        }
        const summary = buildSimulatedSummary(input.instruction);
        input.onUpdate({
          kind: 'completed',
          summary,
          spokenSummary: summary,
          details: { simulated: true, providerSessionId: input.session.providerSessionId },
        });
      },
      this.stepDelayMs * (SIMULATED_STEPS.length + 1),
    );
    finalTimer.unref?.();
    timers.push(finalTimer);

    return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
  }

  async cancelTask(jobId: string): Promise<void> {
    this.cancelledJobIds.add(jobId);
    for (const timer of this.timersByJobId.get(jobId) ?? []) clearTimeout(timer);
    this.timersByJobId.delete(jobId);
  }

  async getTaskStatus(jobId: string): Promise<CodingJobStatus> {
    return { jobId, running: this.timersByJobId.has(jobId) };
  }
}

export function buildSimulatedSummary(instruction: string): string {
  const shortened = instruction.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `Simulated run: applied the change for "${shortened}", added a test covering it, and the test suite passed.`;
}
