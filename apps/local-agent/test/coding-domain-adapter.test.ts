import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import type { SoremaEvent } from '@sorema/domain-model';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore } from '../src/store/local-store.js';
import { ProjectRegistry, createProjectIdentifier } from '../src/projects/project-registry.js';
import {
  CodingDomainAdapter,
  buildStartSpokenSummary,
} from '../src/domains/coding/coding-domain-adapter.js';
import { FakeCodingProvider } from '../src/domains/coding/providers/fake-coding-provider.js';
import type { CodingProvider } from '../src/domains/coding/provider-types.js';

const silentLogger = createLogger('test', 'fatal', false);

function createWorkspace(): { root: string; projectPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ct-adapter-'));
  const projectPath = join(root, 'ai-sorema');
  mkdirSync(projectPath, { recursive: true });
  // The registry only offers folders git is tracking, so an untracked one here would be invisible
  // and every harness in this file would fail for a reason none of them is about.
  mkdirSync(join(projectPath, '.git'), { recursive: true });
  return { root, projectPath };
}

type Harness = {
  adapter: CodingDomainAdapter;
  store: LocalStore;
  events: SoremaEvent[];
  projectId: string;
  projectPath: string;
  root: string;
};

function createHarness(demoMode = false): Harness {
  const { root, projectPath } = createWorkspace();
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const projectRegistry = new ProjectRegistry([root]);
  const events: SoremaEvent[] = [];
  const adapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers: [new FakeCodingProvider({ stepDelayMs: 10 })],
    publishEvent: (event) => events.push(event),
    logger: silentLogger,
    userId: 'user_1',
    deviceId: 'dev_1',
    demoMode,
  });
  const projectId = projectRegistry.listProjects().find((p) => p.name === 'ai-sorema')?.id;
  if (!projectId) throw new Error('test project was not discovered');
  return { adapter, store, events, projectId, projectPath, root };
}

function baseCommand(name: string, payload: unknown) {
  return {
    command: { name, payload } as never,
    userId: 'user_1',
    deviceId: 'dev_1',
    correlationId: 'corr_1',
    idempotencyKey: `${name}:${JSON.stringify(payload)}`,
  };
}

async function waitForEvent(
  events: SoremaEvent[],
  type: SoremaEvent['type'],
  timeoutMs = 8_000,
): Promise<SoremaEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find((event) => event.type === type);
    if (match) return match;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(
    `no ${type} event within ${timeoutMs}ms: ${events.map((e) => e.type).join(', ')}`,
  );
}

describe('project discovery', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('lists only projects inside the authorised roots', async () => {
    const result = (await harness.adapter.execute(baseCommand('projects.list', {}))) as {
      projects: { id: string; name: string }[];
    };
    expect(result.projects.length).toBeGreaterThan(0);
    for (const project of result.projects) {
      expect(project.id).toBeTruthy();
      expect(project.name).toBeTruthy();
      expect(project).not.toHaveProperty('path');
    }
  });

  it('rejects a project id that does not exist', async () => {
    await expect(
      harness.adapter.execute(
        baseCommand('task.start', { projectId: 'proj_unknown', instruction: 'do it' }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'PROJECT_NOT_FOUND' } });
  });

  it('rejects a project id derived from a directory outside the roots', async () => {
    const outsideId = createProjectIdentifier(mkdtempSync(join(tmpdir(), 'ct-outside-')));
    await expect(
      harness.adapter.execute(
        baseCommand('task.start', { projectId: outsideId, instruction: 'do it' }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'PROJECT_NOT_FOUND' } });
  });
});

describe('asynchronous coding jobs', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('returns the original job when the same durable request is retried', async () => {
    const command = baseCommand('task.start', {
      projectId: harness.projectId,
      instruction: 'do it once',
    });

    const first = (await harness.adapter.execute(command)) as { jobId: string };
    const retry = (await harness.adapter.execute(command)) as { jobId: string };

    expect(retry.jobId).toBe(first.jobId);
    expect(harness.store.listJobs()).toHaveLength(1);
    expect(harness.store.listDomainSessions()).toHaveLength(1);
  });

  it('returns a job id immediately without waiting for the work', async () => {
    const startedAt = Date.now();
    const result = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'implement the health check endpoint',
      }),
    )) as { accepted: boolean; jobId: string; domainSessionId: string; status: string };

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('queued');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.store.findJob(result.jobId)).not.toBeNull();
    expect(['queued', 'running']).toContain(harness.store.findJob(result.jobId)?.status);
  });

  it('publishes the full lifecycle and completes the job', async () => {
    const result = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'implement the health check endpoint',
      }),
    )) as { jobId: string };

    await waitForEvent(harness.events, 'job.completed');
    const types = harness.events.map((event) => event.type);
    expect(types).toContain('domain_session.created');
    expect(types).toContain('job.queued');
    expect(types).toContain('job.started');
    expect(types).toContain('job.progress');
    expect(harness.store.findJob(result.jobId)?.status).toBe('completed');
  });

  it('creates a domain session that survives and can be resumed', async () => {
    const first = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'first task' }),
    )) as { domainSessionId: string };
    await waitForEvent(harness.events, 'job.completed');

    const second = (await harness.adapter.execute(
      baseCommand('task.continue', {
        domainSessionId: first.domainSessionId,
        instruction: 'follow-up task',
      }),
    )) as { domainSessionId: string; jobId: string };

    expect(second.domainSessionId).toBe(first.domainSessionId);
    expect(harness.events.some((event) => event.type === 'domain_session.resumed')).toBe(true);
  });

  it('reuses the active session for the same project instead of creating a new one', async () => {
    const first = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'first task' }),
    )) as { domainSessionId: string };
    await waitForEvent(harness.events, 'job.completed');

    const second = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'second task' }),
    )) as { domainSessionId: string };

    expect(second.domainSessionId).toBe(first.domainSessionId);
    expect(harness.store.listDomainSessions()).toHaveLength(1);
  });

  it('starts a fresh session when asked not to continue', async () => {
    const first = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'first task' }),
    )) as { domainSessionId: string };
    await waitForEvent(harness.events, 'job.completed');

    const second = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'clean start',
        continueExistingSession: false,
      }),
    )) as { domainSessionId: string };

    expect(second.domainSessionId).not.toBe(first.domainSessionId);
  });

  it('rejects a follow-up for an unknown session', async () => {
    await expect(
      harness.adapter.execute(
        baseCommand('task.continue', { domainSessionId: 'dsn_nope', instruction: 'go on' }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'CODING_SESSION_NOT_FOUND' } });
    await expect(
      harness.adapter.execute(
        baseCommand('domain_sessions.stop', {
          domainSessionId: 'session-previous-owner',
          confirmed: true,
        }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'CODING_SESSION_NOT_FOUND' } });
  });

  it('rejects a provider that is not usable on this device', async () => {
    await expect(
      harness.adapter.execute(
        baseCommand('task.start', {
          projectId: harness.projectId,
          instruction: 'do it',
          providerPreference: 'claude',
        }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'CODING_PROVIDER_NOT_INSTALLED' } });
  });

  it('falls back to the simulated provider only in demo mode', async () => {
    const demoHarness = createHarness(true);
    const result = (await demoHarness.adapter.execute(
      baseCommand('task.start', {
        projectId: demoHarness.projectId,
        instruction: 'do it',
        providerPreference: 'codex',
      }),
    )) as { providerId: string; spokenSummary: string };
    expect(result.providerId).toBe('fake');
    expect(result.spokenSummary).toContain('simulated');
  });
});

describe('session management', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  async function completedSession(): Promise<string> {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'initial task' }),
    )) as { domainSessionId: string };
    await waitForEvent(harness.events, 'job.completed');
    return started.domainSessionId;
  }

  it('lists safe project identity and active-job state', async () => {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'long task' }),
    )) as { domainSessionId: string; jobId: string };
    const listed = (await harness.adapter.execute(baseCommand('domain_sessions.list', {}))) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(listed.sessions[0]).toMatchObject({
      id: started.domainSessionId,
      projectId: harness.projectId,
      projectName: 'ai-sorema',
      activeJobId: started.jobId,
    });
  });

  it('never lists or operates on sessions left by a previously paired account', async () => {
    const timestamp = new Date().toISOString();
    harness.store.saveDomainSession({
      id: 'session-previous-owner',
      userId: 'user_previous',
      deviceId: 'device_previous',
      domain: 'coding',
      providerId: 'fake',
      providerSessionId: 'native-secret',
      projectPath: harness.projectPath,
      title: 'Private previous work',
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { private: true },
    });

    const listed = (await harness.adapter.execute(
      baseCommand('domain_sessions.list', { includeArchived: true }),
    )) as { sessions: Array<{ id: string }> };
    expect(listed.sessions).toEqual([]);
    await expect(
      harness.adapter.execute(
        baseCommand('domain_sessions.rename', {
          domainSessionId: 'session-previous-owner',
          title: 'stolen',
        }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'CODING_SESSION_NOT_FOUND' } });
  });

  it('sends only dashboard-safe fields over the session-list protocol', async () => {
    await completedSession();
    const listed = (await harness.adapter.execute(baseCommand('domain_sessions.list', {}))) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(listed.sessions[0]).not.toHaveProperty('projectPath');
    expect(listed.sessions[0]).not.toHaveProperty('providerSessionId');
    expect(listed.sessions[0]).not.toHaveProperty('metadata');
    expect(listed.sessions[0]).not.toHaveProperty('userId');
    expect(listed.sessions[0]).not.toHaveProperty('deviceId');
  });

  it('renames only Sorema metadata and archives and restores a finished session', async () => {
    const domainSessionId = await completedSession();
    const nativeId = harness.store.findDomainSession(domainSessionId)?.providerSessionId;

    const renamed = (await harness.adapter.execute(
      baseCommand('domain_sessions.rename', { domainSessionId, title: 'Release preparation' }),
    )) as { session: { title: string } };
    expect(renamed.session).toMatchObject({ title: 'Release preparation' });
    expect(renamed.session).not.toHaveProperty('providerSessionId');
    expect(harness.store.findDomainSession(domainSessionId)?.providerSessionId).toBe(nativeId);

    await harness.adapter.execute(
      baseCommand('domain_sessions.archive', { domainSessionId, archived: true }),
    );
    const visible = (await harness.adapter.execute(baseCommand('domain_sessions.list', {}))) as {
      sessions: unknown[];
    };
    const includingArchived = (await harness.adapter.execute(
      baseCommand('domain_sessions.list', { includeArchived: true }),
    )) as { sessions: Array<{ archivedAt?: string }> };
    expect(visible.sessions).toEqual([]);
    expect(includingArchived.sessions[0]?.archivedAt).toBeTruthy();

    await harness.adapter.execute(
      baseCommand('domain_sessions.archive', { domainSessionId, archived: false }),
    );
    expect(harness.store.findDomainSession(domainSessionId)?.archivedAt).toBeUndefined();
  });

  it('starts a genuinely new native session in the same project', async () => {
    const domainSessionId = await completedSession();
    const sourceNativeId = harness.store.findDomainSession(domainSessionId)?.providerSessionId;
    const next = (await harness.adapter.execute(
      baseCommand('domain_sessions.start_new', {
        domainSessionId,
        instruction: 'work independently on the docs',
      }),
    )) as { domainSessionId: string };

    expect(next.domainSessionId).not.toBe(domainSessionId);
    expect(harness.store.findDomainSession(next.domainSessionId)?.projectPath).toBe(
      harness.projectPath,
    );
    expect(harness.store.findDomainSession(next.domainSessionId)?.providerSessionId).not.toBe(
      sourceNativeId,
    );
  });

  it('refuses two separate sessions in the same working tree at the same time', async () => {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'first task' }),
    )) as { domainSessionId: string };

    await expect(
      harness.adapter.execute(
        baseCommand('domain_sessions.start_new', {
          domainSessionId: started.domainSessionId,
          instruction: 'second task at the same time',
        }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'COMMAND_REJECTED' } });
    expect(harness.store.listDomainSessions()).toHaveLength(1);
  });

  it('serializes simultaneous starts before either provider can create a session', async () => {
    const [first, second] = await Promise.allSettled([
      harness.adapter.execute(
        baseCommand('task.start', { projectId: harness.projectId, instruction: 'first task' }),
      ),
      harness.adapter.execute(
        baseCommand('task.start', {
          projectId: harness.projectId,
          instruction: 'second independent task',
          continueExistingSession: false,
        }),
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(harness.store.listDomainSessions()).toHaveLength(1);
    expect(harness.store.listJobs()).toHaveLength(1);
  });

  it('stops the active job belonging to the selected session', async () => {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'long task' }),
    )) as { domainSessionId: string; jobId: string };
    const stopCommand = baseCommand('domain_sessions.stop', {
      domainSessionId: started.domainSessionId,
      confirmed: true,
    });
    const stopped = (await harness.adapter.execute(stopCommand)) as {
      jobId: string;
      cancelled: boolean;
    };

    expect(stopped).toMatchObject({ jobId: started.jobId, cancelled: true });
    expect(harness.store.findDomainSession(started.domainSessionId)?.status).toBe('idle');
    await expect(harness.adapter.execute(stopCommand)).resolves.toEqual(stopped);
  });
});

describe('cancellation', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });

  it('cancels a running job and publishes the event', async () => {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'long task' }),
    )) as { jobId: string };

    const result = (await harness.adapter.execute(
      baseCommand('job.cancel', { jobId: started.jobId, confirmed: true }),
    )) as { cancelled: boolean; status: string };

    expect(result.cancelled).toBe(true);
    expect(result.status).toBe('cancelled');
    await waitForEvent(harness.events, 'job.cancelled');
  });

  it('reports that an already finished job cannot be cancelled', async () => {
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'quick task' }),
    )) as { jobId: string };
    await waitForEvent(harness.events, 'job.completed');

    const result = (await harness.adapter.execute(
      baseCommand('job.cancel', { jobId: started.jobId, confirmed: true }),
    )) as { cancelled: boolean; status: string };

    expect(result.cancelled).toBe(false);
    expect(result.status).toBe('completed');
  });

  it('reports a missing job', async () => {
    await expect(
      harness.adapter.execute(baseCommand('job.cancel', { jobId: 'job_nope', confirmed: true })),
    ).rejects.toMatchObject({ structured: { code: 'JOB_NOT_FOUND' } });
  });
});

describe('restart recovery', () => {
  it('marks jobs left running as interrupted and reports them', async () => {
    const harness = createHarness();
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'long task' }),
    )) as { jobId: string };

    const interrupted = harness.adapter.markInterruptedJobsAfterRestart();

    expect(interrupted.map((job) => job.id)).toContain(started.jobId);
    expect(harness.store.findJob(started.jobId)?.status).toBe('interrupted');
    const failure = await waitForEvent(harness.events, 'job.failed');
    expect(failure.payload).toMatchObject({ jobId: started.jobId });
  });

  it('keeps the domain session so the work can be picked up again', async () => {
    const harness = createHarness();
    const started = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'long task' }),
    )) as { domainSessionId: string };
    harness.adapter.markInterruptedJobsAfterRestart();
    expect(harness.store.findDomainSession(started.domainSessionId)).not.toBeNull();
  });
});

/** Stands in for a real, installed agent: same behaviour as the simulator, a different identity. */
class StubRealProvider implements CodingProvider {
  readonly providerId: string;

  constructor(
    providerId: string,
    private readonly available = true,
  ) {
    this.providerId = providerId;
  }

  private readonly delegate = new FakeCodingProvider({ stepDelayMs: 10 });

  async detect() {
    return {
      ...(await this.delegate.detect()),
      providerId: this.providerId,
      available: this.available,
      status: this.available ? ('ready' as const) : ('misconfigured' as const),
      details: this.available ? {} : { authenticated: false, setupCommand: 'claude auth login' },
    };
  }

  async createSession(input: Parameters<CodingProvider['createSession']>[0]) {
    return { ...(await this.delegate.createSession(input)), providerId: this.providerId };
  }

  async resumeSession(input: Parameters<CodingProvider['resumeSession']>[0]) {
    return { ...(await this.delegate.resumeSession(input)), providerId: this.providerId };
  }

  async sendTask(input: Parameters<CodingProvider['sendTask']>[0]) {
    return { ...(await this.delegate.sendTask(input)), providerId: this.providerId };
  }

  async cancelTask(jobId: string) {
    return this.delegate.cancelTask(jobId);
  }

  async getTaskStatus(jobId: string) {
    return this.delegate.getTaskStatus(jobId);
  }
}

function createHarnessWithRealProvider(
  demoMode: boolean,
  realProviderIds: string[] = ['codex'],
  unavailableProviderIds: string[] = [],
): Harness {
  const { root, projectPath } = createWorkspace();
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const projectRegistry = new ProjectRegistry([root]);
  const events: SoremaEvent[] = [];
  const adapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers: [
      new FakeCodingProvider({ stepDelayMs: 10 }),
      ...realProviderIds.map(
        (providerId) =>
          new StubRealProvider(providerId, !unavailableProviderIds.includes(providerId)),
      ),
    ],
    publishEvent: (event) => events.push(event),
    logger: silentLogger,
    userId: 'user_1',
    deviceId: 'dev_1',
    demoMode,
  });
  const projectId = projectRegistry.listProjects().find((p) => p.name === 'ai-sorema')?.id;
  if (!projectId) throw new Error('test project was not discovered');
  return { adapter, store, events, projectId, projectPath, root };
}

describe('demo mode is a hard guarantee, not a default', () => {
  it('refuses to run a real provider even when one is explicitly requested', async () => {
    const harness = createHarnessWithRealProvider(true);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'analyse this project',
        providerPreference: 'codex',
      }),
    )) as { providerId: string; spokenSummary: string };

    expect(result.providerId).toBe('fake');
    expect(result.spokenSummary).toContain('simulated');
  });

  it('uses the requested real provider once demo mode is off', async () => {
    const harness = createHarnessWithRealProvider(false);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'analyse this project',
        providerPreference: 'codex',
      }),
    )) as { providerId: string; spokenSummary: string };

    expect(result.providerId).toBe('codex');
    expect(result.spokenSummary).not.toContain('simulated');
  });

  it('never says simulated for a provider that is not the simulator', () => {
    const session = { projectPath: 'C:/projects/zkeys', title: 'zkeys' } as Parameters<
      typeof buildStartSpokenSummary
    >[0];
    expect(buildStartSpokenSummary(session, false, 'fake')).toContain('simulated');
    expect(buildStartSpokenSummary(session, false, 'codex')).not.toContain('simulated');
    expect(buildStartSpokenSummary(session, false, 'claude')).not.toContain('simulated');
  });
});

describe('choosing between agents is the user decision, not an array index', () => {
  it('refuses to guess when two real agents could both do the work', async () => {
    const harness = createHarnessWithRealProvider(false, ['codex', 'claude']);
    await expect(
      harness.adapter.execute(
        baseCommand('task.start', { projectId: harness.projectId, instruction: 'do it' }),
      ),
    ).rejects.toMatchObject({ structured: { code: 'PROVIDER_CHOICE_REQUIRED' } });
  });

  it('tells the assistant which agents to offer', async () => {
    const harness = createHarnessWithRealProvider(false, ['codex', 'claude']);
    await harness.adapter
      .execute(baseCommand('task.start', { projectId: harness.projectId, instruction: 'do it' }))
      .then(
        () => expect.unreachable('should have refused to choose'),
        (error: { structured: { details?: { availableProviders?: string[] } } }) => {
          expect(error.structured.details?.availableProviders).toEqual(['codex', 'claude']);
        },
      );
  });

  it('proceeds without asking once the user has named one', async () => {
    const harness = createHarnessWithRealProvider(false);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', {
        projectId: harness.projectId,
        instruction: 'do it',
        providerPreference: 'codex',
      }),
    )) as { providerId: string };
    expect(result.providerId).toBe('codex');
  });

  /**
   * The machine is the last word on which agents exist, so its refusal has to be recoverable.
   *
   * A preference can arrive from a conversation that ended months ago, or from an account
   * preference recorded on a different computer, and naming an agent this machine does not have is
   * ordinary rather than exceptional. Refusing with nothing but the name that failed leaves the
   * assistant guessing a second time; refusing with the list lets it offer the alternative out
   * loud, which is the only acceptable way to change which account gets billed for the work.
   */
  it('refuses a preference this machine cannot honour, and says what it can', async () => {
    const harness = createHarnessWithRealProvider(false, ['claude']);
    await harness.adapter
      .execute(
        baseCommand('task.start', {
          projectId: harness.projectId,
          instruction: 'do it',
          providerPreference: 'coding.claude',
        }),
      )
      .then(
        () => expect.unreachable('should have refused a capability id'),
        (error: { structured: { code: string; details?: { availableProviders?: string[] } } }) => {
          expect(error.structured.code).toBe('CODING_PROVIDER_NOT_INSTALLED');
          expect(error.structured.details?.availableProviders).toEqual(['claude']);
        },
      );
  });

  it('does not ask when only one agent is installed', async () => {
    const harness = createHarnessWithRealProvider(false, ['codex']);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'do it' }),
    )) as { providerId: string };
    expect(result.providerId).toBe('codex');
  });

  it('uses the one authenticated agent instead of asking about an installed but unusable one', async () => {
    const harness = createHarnessWithRealProvider(false, ['codex', 'claude'], ['claude']);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'do it' }),
    )) as { providerId: string };

    expect(result.providerId).toBe('codex');
  });

  it('tells the user how to sign in when they explicitly request unauthenticated Claude', async () => {
    const harness = createHarnessWithRealProvider(false, ['codex', 'claude'], ['claude']);
    await harness.adapter
      .execute(
        baseCommand('task.start', {
          projectId: harness.projectId,
          instruction: 'do it',
          providerPreference: 'claude',
        }),
      )
      .then(
        () => expect.unreachable('Claude should not start before it is authenticated'),
        (error: {
          structured: { code: string; userMessage?: string; details?: Record<string, unknown> };
        }) => {
          expect(error.structured.code).toBe('CODING_PROVIDER_NOT_INSTALLED');
          expect(error.structured.userMessage).toContain('claude auth login');
          expect(error.structured.details).toMatchObject({
            requestedProvider: 'claude',
            requestedProviderStatus: 'misconfigured',
            availableProviders: ['codex'],
          });
        },
      );
  });

  it('does not ask in demo mode, where the simulator always wins', async () => {
    const harness = createHarnessWithRealProvider(true, ['codex', 'claude']);
    const result = (await harness.adapter.execute(
      baseCommand('task.start', { projectId: harness.projectId, instruction: 'do it' }),
    )) as { providerId: string };
    expect(result.providerId).toBe('fake');
  });
});
