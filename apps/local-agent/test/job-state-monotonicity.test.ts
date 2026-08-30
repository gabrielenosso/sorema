import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import { createStructuredError, type SoremaEvent } from '@sorema/domain-model';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore } from '../src/store/local-store.js';
import { ProjectRegistry } from '../src/projects/project-registry.js';
import { CodingDomainAdapter } from '../src/domains/coding/coding-domain-adapter.js';
import type {
  CodingJob,
  CodingJobStatus,
  CodingProvider,
  CodingSession,
  CodingTaskUpdate,
  CreateCodingSessionInput,
  ExistingCodingSession,
  ProviderDetectionResult,
  ResumeCodingSessionInput,
  SendCodingTaskInput,
} from '../src/domains/coding/provider-types.js';

/**
 * A provider whose updates are driven by the test, so out-of-order and duplicated updates can be
 * replayed deliberately rather than waited for.
 */
class ScriptedCodingProvider implements CodingProvider {
  readonly providerId = 'fake';
  private emit: ((update: CodingTaskUpdate) => void) | null = null;

  async detect(): Promise<ProviderDetectionResult> {
    return { providerId: this.providerId, available: true, status: 'ready' };
  }

  async listExistingSessions(): Promise<ExistingCodingSession[]> {
    return [];
  }

  async createSession(input: CreateCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: 'scripted-session',
      projectPath: input.projectPath,
      title: input.title,
      metadata: {},
    };
  }

  async resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession> {
    return {
      providerId: this.providerId,
      providerSessionId: input.providerSessionId ?? 'scripted-session',
      projectPath: input.projectPath,
      title: input.title,
      metadata: {},
    };
  }

  async sendTask(input: SendCodingTaskInput): Promise<CodingJob> {
    this.emit = input.onUpdate;
    return { jobId: input.jobId, providerId: this.providerId, status: 'running' };
  }

  async cancelTask(): Promise<void> {}

  async getTaskStatus(jobId: string): Promise<CodingJobStatus> {
    return { jobId, running: true };
  }

  push(update: CodingTaskUpdate): void {
    this.emit?.(update);
  }
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'ct-monotonic-'));
  mkdirSync(join(root, 'demo'), { recursive: true });
  // Only folders git is tracking are offered as projects.
  mkdirSync(join(root, 'demo', '.git'), { recursive: true });
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const projectRegistry = new ProjectRegistry([root]);
  const provider = new ScriptedCodingProvider();
  const events: SoremaEvent[] = [];
  const adapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers: [provider],
    publishEvent: (event) => events.push(event),
    logger: createLogger('test', 'fatal', false),
    userId: 'user_1',
    deviceId: 'dev_1',
    demoMode: false,
  });
  const projectId = projectRegistry.listProjects().find((p) => p.name === 'demo')?.id ?? '';
  return { adapter, store, provider, events, projectId };
}

async function startJob(harness: ReturnType<typeof createHarness>): Promise<string> {
  const result = (await harness.adapter.execute({
    command: {
      name: 'task.start',
      payload: { projectId: harness.projectId, instruction: 'implement the health check' },
    },
    userId: 'user_1',
    deviceId: 'dev_1',
    correlationId: 'corr_1',
    idempotencyKey: `idem_${Math.random().toString(16).slice(2)}`,
  })) as { jobId: string };
  return result.jobId;
}

describe('a finished job stays finished', () => {
  it('ignores a progress update that arrives after completion', async () => {
    const harness = createHarness();
    const jobId = await startJob(harness);

    harness.provider.push({ kind: 'started' });
    harness.provider.push({
      kind: 'completed',
      summary: 'done',
      spokenSummary: 'It is done.',
    });
    harness.provider.push({ kind: 'progress', progress: 0.5, message: 'a late straggler' });

    expect(harness.store.findJob(jobId)?.status).toBe('completed');
    expect(harness.store.findJob(jobId)?.summary).toBe('done');
    expect(harness.events.filter((event) => event.type === 'job.completed')).toHaveLength(1);
  });

  it('ignores a second terminal update so the user is only told once', async () => {
    const harness = createHarness();
    const jobId = await startJob(harness);

    harness.provider.push({ kind: 'started' });
    harness.provider.push({ kind: 'completed', summary: 'done', spokenSummary: 'It is done.' });
    harness.provider.push({
      kind: 'failed',
      error: createStructuredError('INTERNAL_ERROR', 'a late failure'),
    });

    expect(harness.store.findJob(jobId)?.status).toBe('completed');
    expect(harness.events.filter((event) => event.type === 'job.failed')).toHaveLength(0);
  });

  it('does not restart a cancelled job when the provider keeps talking', async () => {
    const harness = createHarness();
    const jobId = await startJob(harness);
    harness.provider.push({ kind: 'started' });

    await harness.adapter.execute({
      command: { name: 'job.cancel', payload: { jobId, confirmed: true } },
      userId: 'user_1',
      deviceId: 'dev_1',
      correlationId: 'corr_1',
      idempotencyKey: 'idem_cancel',
    });

    harness.provider.push({ kind: 'progress', progress: 0.9, message: 'still going' });
    harness.provider.push({ kind: 'completed', summary: 'done', spokenSummary: 'done' });

    expect(harness.store.findJob(jobId)?.status).toBe('cancelled');
    expect(harness.events.filter((event) => event.type === 'job.completed')).toHaveLength(0);
  });

  it('does not resurrect a job that was interrupted by a restart', async () => {
    const harness = createHarness();
    const jobId = await startJob(harness);
    harness.provider.push({ kind: 'started' });

    harness.adapter.markInterruptedJobsAfterRestart();
    harness.provider.push({ kind: 'completed', summary: 'done', spokenSummary: 'done' });

    expect(harness.store.findJob(jobId)?.status).toBe('interrupted');
  });
});
