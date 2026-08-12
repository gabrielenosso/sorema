import {
  SoremaError,
  createDomainSessionId,
  createEventId,
  createJobId,
  isTerminalJobStatus,
  nowIsoTimestamp,
  type Capability,
  type SoremaEvent,
  type DomainSession,
  type JobStatus,
  type ProjectSummary,
  type StructuredError,
} from '@sorema/domain-model';
import type { Logger } from '@sorema/observability';
import type { LocalJob, LocalStore } from '../../store/local-store.js';
import type { ProjectRegistry } from '../../projects/project-registry.js';
import type { DomainAdapter, DomainCommand } from '../domain-adapter.js';
import type { CodingProvider, CodingSession, CodingTaskUpdate } from './provider-types.js';
import { FAKE_PROVIDER_ID } from './providers/fake-coding-provider.js';

const HANDLED_COMMAND_NAMES = new Set([
  'task.start',
  'task.continue',
  'job.status',
  'job.cancel',
  'jobs.list',
  'domain_sessions.list',
  'projects.list',
  'projects.create',
]);

export type CodingDomainAdapterOptions = {
  store: LocalStore;
  projectRegistry: ProjectRegistry;
  providers: CodingProvider[];
  publishEvent: (event: SoremaEvent) => void;
  logger: Logger;
  userId: string;
  deviceId: string;
  demoMode: boolean;
};

export class CodingDomainAdapter implements DomainAdapter {
  readonly domain = 'coding';

  private readonly options: CodingDomainAdapterOptions;
  private readonly providersById = new Map<string, CodingProvider>();
  private stopped = false;

  constructor(options: CodingDomainAdapterOptions) {
    this.options = options;
    for (const provider of options.providers) this.providersById.set(provider.providerId, provider);
  }

  handles(commandName: DomainCommand['command']['name'], domain?: string): boolean {
    if (domain !== undefined && domain !== this.domain) return false;
    return HANDLED_COMMAND_NAMES.has(commandName);
  }

  async detectCapabilities(): Promise<Capability[]> {
    const capabilities: Capability[] = [];
    for (const provider of this.providersById.values()) {
      const detection = await provider.detect();
      capabilities.push({
        id: `coding.${detection.providerId}`,
        domain: this.domain,
        providerId: detection.providerId,
        version: detection.version,
        available: detection.available,
        status: detection.status,
        details: detection.details,
      });
    }
    return capabilities;
  }

  async listAvailableProviders(): Promise<CodingProvider[]> {
    const available: CodingProvider[] = [];
    for (const provider of this.providersById.values()) {
      const detection = await provider.detect();
      if (detection.available) available.push(provider);
    }
    return available;
  }

  async execute(command: DomainCommand): Promise<unknown> {
    switch (command.command.name) {
      case 'projects.list':
        return {
          projects: this.options.projectRegistry.listProjects(command.command.payload.search),
        };
      case 'projects.create':
        return this.createProject(command.command.payload.name);
      case 'domain_sessions.list':
        return {
          sessions: this.options.store.listDomainSessions({
            domain: command.command.payload.domain,
            projectPath: command.command.payload.projectPath,
          }),
        };
      case 'jobs.list':
        return {
          jobs: this.options.store
            .listJobs({ activeOnly: command.command.payload.activeOnly })
            .map(stripLocalJobFields),
        };
      case 'job.status': {
        const job = this.options.store.findJob(command.command.payload.jobId);
        if (!job) {
          throw SoremaError.of('JOB_NOT_FOUND', `No job with id ${command.command.payload.jobId}`);
        }
        return { job: stripLocalJobFields(job) };
      }
      case 'job.cancel':
        return this.cancelJob(
          command.command.payload.jobId,
          command.command.payload.confirmed,
          command.command.payload.reason,
        );
      case 'task.start':
        return this.startTask(command);
      case 'task.continue':
        return this.continueTask(command);
      default:
        throw SoremaError.of(
          'COMMAND_REJECTED',
          `The coding domain cannot handle ${command.command.name}`,
        );
    }
  }

  private createProject(name: string): { project: ProjectSummary; alreadyExisted: boolean } {
    const before = this.options.projectRegistry.listProjects().length;
    const project = this.options.projectRegistry.createProject(name);
    const alreadyExisted = this.options.projectRegistry.listProjects().length === before;
    return { project, alreadyExisted };
  }

  private async selectProvider(preference?: string): Promise<CodingProvider> {
    const available = await this.listAvailableProviders();
    if (available.length === 0) {
      throw SoremaError.of(
        'CODING_PROVIDER_NOT_INSTALLED',
        'No coding provider is available on this device',
      );
    }
    // Demo mode is a promise that nothing real happens on this machine, so it outranks any
    // preference. Letting a named provider through would run a real agent against real files while
    // the assistant announces a simulation, which is the worst possible combination.
    const simulated = available.find((provider) => provider.providerId === FAKE_PROVIDER_ID);
    if (this.options.demoMode && simulated) return simulated;

    const realProviders = available.filter((provider) => provider.providerId !== FAKE_PROVIDER_ID);

    if (preference) {
      const preferred = available.find((provider) => provider.providerId === preference);
      if (preferred) return preferred;
      // The refusal carries the alternatives, because a preference that no longer fits is ordinary:
      // it can come from an account preference recorded on another machine, or from a conversation
      // months ago, or from a capability id guessed in place of a provider id. Naming only what
      // failed leaves the assistant to guess again; naming what is here lets it offer the other
      // agent out loud, which is the only acceptable way to move work onto a different account.
      throw SoremaError.of(
        'CODING_PROVIDER_NOT_INSTALLED',
        `The requested provider ${preference} is not usable on this device`,
        {
          details: {
            requestedProvider: preference,
            availableProviders: realProviders.map((provider) => provider.providerId),
          },
        },
      );
    }

    // With a genuine choice, picking one would be an accident of registration order, and it would
    // silently deny the user the choice the product promises them. Surfacing the options lets the
    // assistant ask once and remember the answer for this project.
    if (realProviders.length > 1) {
      throw SoremaError.of(
        'PROVIDER_CHOICE_REQUIRED',
        'More than one agent can do this work and no preference has been recorded',
        { details: { availableProviders: realProviders.map((provider) => provider.providerId) } },
      );
    }

    // With demo mode off, a real agent always beats the simulator, whatever order they registered in.
    return (realProviders[0] ?? available[0]) as CodingProvider;
  }

  private async startTask(command: DomainCommand): Promise<unknown> {
    if (command.command.name !== 'task.start') {
      throw SoremaError.of('COMMAND_REJECTED', 'Unexpected command');
    }
    const duplicate = this.options.store.findJobByIdempotencyKey(command.idempotencyKey);
    if (duplicate?.domainSessionId) {
      return {
        accepted: true as const,
        jobId: duplicate.id,
        domainSessionId: duplicate.domainSessionId,
        providerId: duplicate.providerId,
        domain: duplicate.domain,
        status: 'queued' as const,
        spokenSummary: 'This task was already accepted.',
      };
    }
    const { payload } = command.command;
    const projectPath = this.options.projectRegistry.resolveProjectPath(payload.projectId);
    const provider = await this.selectProvider(payload.providerPreference);

    const existing =
      payload.continueExistingSession === false
        ? null
        : this.options.store.findReusableSessionForProject(projectPath, provider.providerId);

    const session = existing
      ? await this.resumeDomainSession(existing, provider)
      : await this.createDomainSession(projectPath, provider, payload.instruction);

    return this.dispatchTask({
      session,
      provider,
      instruction: payload.instruction,
      command,
      conversationId: payload.conversationId,
      resumed: Boolean(existing),
    });
  }

  private async continueTask(command: DomainCommand): Promise<unknown> {
    if (command.command.name !== 'task.continue') {
      throw SoremaError.of('COMMAND_REJECTED', 'Unexpected command');
    }
    const { payload } = command.command;
    const stored = this.options.store.findDomainSession(payload.domainSessionId);
    if (!stored || stored.domain !== 'coding') {
      throw SoremaError.of(
        'CODING_SESSION_NOT_FOUND',
        `No coding session with id ${payload.domainSessionId}`,
      );
    }
    const provider = this.providersById.get(stored.providerId);
    if (!provider) {
      throw SoremaError.of(
        'CODING_PROVIDER_NOT_INSTALLED',
        `Provider ${stored.providerId} is no longer registered on this device`,
      );
    }
    const session = await this.resumeDomainSession(stored, provider);
    return this.dispatchTask({
      session,
      provider,
      instruction: payload.instruction,
      command,
      conversationId: payload.conversationId,
      resumed: true,
    });
  }

  private async createDomainSession(
    projectPath: string,
    provider: CodingProvider,
    instruction: string,
  ): Promise<DomainSession> {
    const title = buildSessionTitle(projectPath, instruction);
    const providerSession = await provider.createSession({ projectPath, title });
    const timestamp = nowIsoTimestamp();
    const session: DomainSession = {
      id: createDomainSessionId(),
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      domain: 'coding',
      providerId: provider.providerId,
      providerSessionId: providerSession.providerSessionId,
      projectPath,
      title,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: providerSession.metadata,
    };
    this.options.store.saveDomainSession(session);
    this.publish('domain_session.created', session.id, { session });
    return session;
  }

  private async resumeDomainSession(
    stored: DomainSession,
    provider: CodingProvider,
  ): Promise<DomainSession> {
    const providerSession = await provider.resumeSession({
      providerSessionId: stored.providerSessionId,
      projectPath: stored.projectPath ?? '',
      title: stored.title,
      metadata: stored.metadata,
    });
    const session: DomainSession = {
      ...stored,
      providerSessionId: providerSession.providerSessionId ?? stored.providerSessionId,
      status: 'active',
      updatedAt: nowIsoTimestamp(),
      metadata: providerSession.metadata,
    };
    this.options.store.saveDomainSession(session);
    this.publish('domain_session.resumed', session.id, { session });
    return session;
  }

  private async dispatchTask(input: {
    session: DomainSession;
    provider: CodingProvider;
    instruction: string;
    command: DomainCommand;
    conversationId?: string;
    resumed: boolean;
  }): Promise<unknown> {
    const jobId = createJobId();
    const job: LocalJob = {
      id: jobId,
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      conversationId: input.conversationId,
      domainSessionId: input.session.id,
      domain: this.domain,
      type: 'coding.task',
      status: 'queued',
      createdAt: nowIsoTimestamp(),
      idempotencyKey: input.command.idempotencyKey,
      correlationId: input.command.correlationId,
      instruction: input.instruction,
      providerId: input.provider.providerId,
    };
    this.options.store.saveJob(job);
    this.publish('job.queued', jobId, {
      jobId,
      domain: this.domain,
      domainSessionId: input.session.id,
      conversationId: input.conversationId,
      type: job.type,
      idempotencyKey: job.idempotencyKey,
    });

    const providerSession: CodingSession = {
      providerId: input.provider.providerId,
      providerSessionId: input.session.providerSessionId,
      projectPath: input.session.projectPath ?? '',
      title: input.session.title,
      metadata: input.session.metadata,
    };

    void input.provider
      .sendTask({
        jobId,
        session: providerSession,
        instruction: input.instruction,
        onUpdate: (update) => this.handleTaskUpdate(jobId, input.session.id, update),
      })
      .catch((error: unknown) => {
        this.handleTaskUpdate(jobId, input.session.id, {
          kind: 'failed',
          error: toStructured(error),
        });
      });

    return {
      accepted: true as const,
      jobId,
      domainSessionId: input.session.id,
      providerId: input.provider.providerId,
      domain: this.domain,
      status: 'queued' as const,
      spokenSummary: buildStartSpokenSummary(
        input.session,
        input.resumed,
        input.provider.providerId,
      ),
    };
  }

  private handleTaskUpdate(jobId: string, domainSessionId: string, update: CodingTaskUpdate): void {
    if (this.stopped) return;
    const job = this.options.store.findJob(jobId);
    if (!job) return;
    if (isTerminalJobStatus(job.status) || job.status === 'interrupted') {
      this.options.logger.debug(
        { jobId, status: job.status, updateKind: update.kind },
        'ignored a provider update for a job that already reached a final state',
      );
      return;
    }
    const shared = {
      jobId,
      domain: this.domain,
      domainSessionId,
      conversationId: job.conversationId,
    };

    switch (update.kind) {
      case 'started': {
        const startedAt = nowIsoTimestamp();
        this.options.store.saveJob({ ...job, status: 'running', startedAt });
        this.publish('job.started', jobId, { ...shared, startedAt });
        return;
      }
      case 'session_identified': {
        const session = this.options.store.findDomainSession(domainSessionId);
        if (!session) return;
        this.options.store.saveDomainSession({
          ...session,
          providerSessionId: update.providerSessionId,
          updatedAt: nowIsoTimestamp(),
        });
        return;
      }
      case 'progress': {
        this.options.store.saveJob({
          ...job,
          status: 'running',
          progress: update.progress,
          summary: update.message,
        });
        this.publish('job.progress', jobId, {
          ...shared,
          progress: update.progress,
          message: update.message,
        });
        return;
      }
      case 'completed': {
        const completedAt = nowIsoTimestamp();
        this.options.store.saveJob({
          ...job,
          status: 'completed',
          progress: 1,
          summary: update.summary,
          completedAt,
        });
        this.markSessionIdle(domainSessionId);
        this.publish('job.completed', jobId, {
          ...shared,
          summary: update.summary,
          spokenSummary: update.spokenSummary,
          completedAt,
          details: update.details,
        });
        return;
      }
      case 'failed': {
        const completedAt = nowIsoTimestamp();
        this.options.store.saveJob({
          ...job,
          status: 'failed',
          error: update.error,
          completedAt,
        });
        this.markSessionIdle(domainSessionId);
        this.publish('job.failed', jobId, { ...shared, error: update.error, completedAt });
        return;
      }
      default:
        return;
    }
  }

  private markSessionIdle(domainSessionId: string): void {
    const session = this.options.store.findDomainSession(domainSessionId);
    if (!session) return;
    this.options.store.saveDomainSession({
      ...session,
      status: 'idle',
      updatedAt: nowIsoTimestamp(),
    });
  }

  /**
   * The machine is the last place that can refuse, so it is the place that must.
   *
   * The protocol has carried `confirmed` all along and this ignored it, which made the flag
   * decorative: anything that reached the tunnel — a second client, a replayed frame, a cloud with
   * the guard removed — stopped a running agent mid-edit without anybody having been asked. The
   * cloud refuses first so the user is not made to wait a round trip to hear the question, but that
   * one is a courtesy and this one is the guarantee.
   */
  private async cancelJob(jobId: string, confirmed: boolean, reason?: string): Promise<unknown> {
    if (!confirmed) {
      throw SoremaError.of(
        'APPROVAL_REQUIRED',
        'Cancellation was requested without explicit user confirmation',
        {
          userMessage:
            'Cancelling can leave half-finished changes on disk. Do you want me to stop it anyway?',
        },
      );
    }
    const job = this.options.store.findJob(jobId);
    if (!job) throw SoremaError.of('JOB_NOT_FOUND', `No job with id ${jobId}`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { jobId, cancelled: false, status: job.status };
    }
    const provider = this.providersById.get(job.providerId);
    await provider?.cancelTask(jobId);
    const completedAt = nowIsoTimestamp();
    this.options.store.saveJob({ ...job, status: 'cancelled', completedAt });
    this.publish('job.cancelled', jobId, {
      jobId,
      domain: this.domain,
      domainSessionId: job.domainSessionId,
      conversationId: job.conversationId,
      reason: reason ?? 'cancelled by the user',
      completedAt,
    });
    return { jobId, cancelled: true, status: 'cancelled' as const };
  }

  /** The adapter's own hook, reached only from inside this process, where nobody is there to ask. */
  async cancel(jobId: string): Promise<void> {
    await this.cancelJob(jobId, true, 'cancelled by the user');
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const job = this.options.store.findJob(jobId);
    if (!job) throw SoremaError.of('JOB_NOT_FOUND', `No job with id ${jobId}`);
    return job.status;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const job of this.options.store.listJobs({ activeOnly: true })) {
      const provider = this.providersById.get(job.providerId);
      await provider?.cancelTask(job.id).catch(() => undefined);
    }
  }

  markInterruptedJobsAfterRestart(): LocalJob[] {
    const unfinished = this.options.store.listUnfinishedJobs();
    for (const job of unfinished) {
      const completedAt = nowIsoTimestamp();
      this.options.store.saveJob({ ...job, status: 'interrupted', completedAt });
      this.publish('job.failed', job.id, {
        jobId: job.id,
        domain: job.domain,
        domainSessionId: job.domainSessionId,
        conversationId: job.conversationId,
        completedAt,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The job was interrupted because the local agent restarted',
          retryable: true,
          userMessage:
            'That task was interrupted when the computer restarted. I can pick it up again from where it left off.',
        } satisfies StructuredError,
      });
    }
    return unfinished;
  }

  private publish(type: SoremaEvent['type'], jobIdOrSessionId: string, payload: unknown): void {
    this.options.publishEvent({
      eventId: createEventId(),
      type,
      occurredAt: nowIsoTimestamp(),
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      correlationId: jobIdOrSessionId,
      payload,
    } as SoremaEvent);
  }
}

function stripLocalJobFields(job: LocalJob) {
  const { instruction: _instruction, providerId: _providerId, ...rest } = job;
  return rest;
}

function toStructured(error: unknown): StructuredError {
  if (error instanceof SoremaError) return error.structured;
  const candidate = (error as { structured?: StructuredError } | null)?.structured;
  if (candidate) return candidate;
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    userMessage: 'The coding agent could not be started.',
  };
}

export function buildSessionTitle(projectPath: string, instruction: string): string {
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project';
  const shortInstruction = instruction.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${projectName}: ${shortInstruction}`;
}

export function buildStartSpokenSummary(
  session: DomainSession,
  resumed: boolean,
  providerId: string,
): string {
  const projectName = session.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? session.title;
  const prefix = resumed ? 'Continuing the existing work on' : 'Starting work on';
  // Derived from the provider actually chosen, never from a config flag: announcing a simulation
  // while a real agent edits real files is the worst thing this system could say.
  const simulatedSuffix = providerId === FAKE_PROVIDER_ID ? ' This is a simulated run.' : '';
  return `${prefix} ${projectName}. I will tell you when it is finished.${simulatedSuffix}`;
}
