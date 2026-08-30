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
import { basename } from 'node:path';
import type { Logger } from '@sorema/observability';
import type { LocalJob, LocalStore } from '../../store/local-store.js';
import type { ProjectRegistry } from '../../projects/project-registry.js';
import { createProjectIdentifier } from '../../projects/project-registry.js';
import type { DomainAdapter, DomainCommand } from '../domain-adapter.js';
import type {
  CodingProvider,
  CodingSession,
  CodingTaskUpdate,
  ExistingCodingSession,
} from './provider-types.js';
import { FAKE_PROVIDER_ID } from './providers/fake-coding-provider.js';

/** Enough to recognise the one they meant, few enough to read back out loud. */
const EXISTING_SESSIONS_PER_PROVIDER = 10;

const HANDLED_COMMAND_NAMES = new Set([
  'task.start',
  'task.continue',
  'job.status',
  'job.cancel',
  'jobs.list',
  'domain_sessions.list',
  'domain_sessions.discover',
  'domain_sessions.rename',
  'domain_sessions.archive',
  'domain_sessions.start_new',
  'domain_sessions.stop',
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
  private readonly startingProjectPaths = new Set<string>();
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
          projects: this.options.projectRegistry
            .listProjects(command.command.payload.search)
            .map(managedProjectFields),
        };
      case 'projects.create': {
        const created = this.createProject(command.command.payload.name);
        return { ...created, project: managedProjectFields(created.project) };
      }
      case 'domain_sessions.list':
        return {
          sessions: this.options.store
            .listDomainSessions({
              domain: command.command.payload.domain,
              projectPath: command.command.payload.projectPath,
              includeArchived: command.command.payload.includeArchived,
              userId: this.options.userId,
              deviceId: this.options.deviceId,
            })
            .map((session) => ({
              ...managedSessionFields(session),
              projectId: session.projectPath
                ? createProjectIdentifier(session.projectPath)
                : `unlinked:${session.id}`,
              projectName: session.projectPath ? basename(session.projectPath) : 'Other work',
              activeJobId: this.options.store.findActiveJobForSession(session.id)?.id,
            })),
        };
      case 'domain_sessions.discover':
        return this.discoverExistingSessions(command.command.payload.projectId);
      case 'domain_sessions.rename':
        return this.renameDomainSession(
          command.command.payload.domainSessionId,
          command.command.payload.title,
        );
      case 'domain_sessions.archive':
        return this.archiveDomainSession(
          command.command.payload.domainSessionId,
          command.command.payload.archived,
        );
      case 'domain_sessions.start_new':
        return this.startNewDomainSession(command);
      case 'domain_sessions.stop': {
        this.requireCodingSession(command.command.payload.domainSessionId);
        const previous = this.options.store.findSessionActionResult(command.idempotencyKey);
        if (previous) return previous;
        const active = this.options.store.findActiveJobForSession(
          command.command.payload.domainSessionId,
        );
        if (!active) {
          throw SoremaError.of('JOB_NOT_FOUND', 'This session has no active job');
        }
        const result = await this.cancelJob(active.id, command.command.payload.confirmed);
        this.options.store.saveSessionActionResult(command.idempotencyKey, result);
        return result;
      }
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

  /**
   * The sessions each installed agent already has for this folder, adopted so that everything
   * downstream can treat them as ordinary Sorema sessions.
   *
   * Discovery on its own would have produced an identifier nothing else accepts: continuing a
   * session, cancelling it and drawing it in the work tab are all written against a stored session
   * row. So a session found in Codex's or Claude's own store gets one, keyed on the provider and
   * the provider's own id, and the same session discovered twice keeps the identifier it was given
   * the first time rather than arriving again as a second copy of the same transcript.
   */
  private async discoverExistingSessions(
    projectId: string,
  ): Promise<{ sessions: ReturnType<typeof managedSessionFields>[] }> {
    const projectPath = this.options.projectRegistry.resolveProjectPath(projectId);
    const providers = await this.listAvailableProviders();
    const adopted: DomainSession[] = [];

    for (const provider of providers) {
      const existing = await provider.listExistingSessions({
        projectPath,
        limit: EXISTING_SESSIONS_PER_PROVIDER,
      });
      for (const found of existing) {
        adopted.push(this.adoptExistingSession(projectPath, provider.providerId, found));
      }
    }

    return {
      sessions: adopted
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(managedSessionFields),
    };
  }

  private adoptExistingSession(
    projectPath: string,
    providerId: string,
    found: ExistingCodingSession,
  ): DomainSession {
    const already = this.options.store
      .listDomainSessions({
        domain: this.domain,
        projectPath,
        includeArchived: true,
        userId: this.options.userId,
        deviceId: this.options.deviceId,
      })
      .find(
        (session) =>
          session.providerId === providerId &&
          session.providerSessionId === found.providerSessionId,
      );
    if (already) return already;

    const session: DomainSession = {
      id: createDomainSessionId(),
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      domain: this.domain,
      providerId,
      providerSessionId: found.providerSessionId,
      projectPath,
      title: found.title,
      status: 'idle',
      createdAt: found.lastActiveAt,
      updatedAt: found.lastActiveAt,
      // `resumedAt` is what tells the Claude provider to pass `--resume` rather than `--session-id`,
      // and a session that started outside Sorema has nothing else to resume from.
      metadata: { adoptedFrom: providerId, resumedAt: found.lastActiveAt },
    };
    this.options.store.saveDomainSession(session);
    this.publish('domain_session.created', session.id, { session });
    return session;
  }

  private requireCodingSession(domainSessionId: string): DomainSession {
    const session = this.options.store.findDomainSession(domainSessionId);
    if (
      !session ||
      session.domain !== this.domain ||
      session.userId !== this.options.userId ||
      session.deviceId !== this.options.deviceId
    ) {
      throw SoremaError.of(
        'CODING_SESSION_NOT_FOUND',
        `No coding session with id ${domainSessionId}`,
      );
    }
    return session;
  }

  private renameDomainSession(
    domainSessionId: string,
    title: string,
  ): { session: ReturnType<typeof managedSessionFields> } {
    const stored = this.requireCodingSession(domainSessionId);
    const session = { ...stored, title: title.trim(), updatedAt: nowIsoTimestamp() };
    this.options.store.saveDomainSession(session);
    return { session: managedSessionFields(session) };
  }

  private archiveDomainSession(
    domainSessionId: string,
    archived: boolean,
  ): { session: ReturnType<typeof managedSessionFields> } {
    const stored = this.requireCodingSession(domainSessionId);
    if (archived && this.options.store.findActiveJobForSession(domainSessionId)) {
      throw SoremaError.of(
        'COMMAND_REJECTED',
        'Stop the active job before archiving this session',
        { userMessage: 'Stop the active work before archiving this session.' },
      );
    }
    const session = this.options.store.setDomainSessionArchived(
      stored.id,
      archived ? nowIsoTimestamp() : null,
    );
    if (!session) throw SoremaError.of('CODING_SESSION_NOT_FOUND', 'The session no longer exists');
    return { session: managedSessionFields(session) };
  }

  private async startNewDomainSession(command: DomainCommand): Promise<unknown> {
    if (command.command.name !== 'domain_sessions.start_new') {
      throw SoremaError.of('COMMAND_REJECTED', 'Unexpected command');
    }
    const duplicate = this.startedJobForDuplicate(command.idempotencyKey);
    if (duplicate) return duplicate;
    const source = this.requireCodingSession(command.command.payload.domainSessionId);
    if (!source.projectPath) {
      throw SoremaError.of('PROJECT_NOT_FOUND', 'This session is not linked to a project');
    }
    const instruction = command.command.payload.instruction;
    this.options.projectRegistry.assertPathIsAllowed(source.projectPath);
    return this.withProjectStartLock(source.projectPath, async () => {
      const provider = await this.selectProvider(source.providerId);
      const session = await this.createDomainSession(source.projectPath!, provider, instruction);
      return this.dispatchTask({
        session,
        provider,
        instruction,
        command,
        resumed: false,
      });
    });
  }

  private async withProjectStartLock<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
    const active = this.options.store.findActiveJobForProject(
      projectPath,
      this.options.userId,
      this.options.deviceId,
    );
    if (active || this.startingProjectPaths.has(projectPath)) {
      throw SoremaError.of('COMMAND_REJECTED', 'Another agent is already using this working tree', {
        userMessage:
          'That repository already has active work. Continue it after the current step finishes, or wait before starting separate work.',
      });
    }
    this.startingProjectPaths.add(projectPath);
    try {
      return await action();
    } finally {
      this.startingProjectPaths.delete(projectPath);
    }
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
      const requestedDetection = await this.providersById.get(preference)?.detect();
      const setupCommand =
        typeof requestedDetection?.details?.setupCommand === 'string'
          ? requestedDetection.details.setupCommand
          : null;
      // The refusal carries the alternatives, because a preference that no longer fits is ordinary:
      // it can come from an account preference recorded on another machine, or from a conversation
      // months ago, or from a capability id guessed in place of a provider id. Naming only what
      // failed leaves the assistant to guess again; naming what is here lets it offer the other
      // agent out loud, which is the only acceptable way to move work onto a different account.
      throw SoremaError.of(
        'CODING_PROVIDER_NOT_INSTALLED',
        `The requested provider ${preference} is not usable on this device`,
        {
          userMessage: setupCommand
            ? `${preference} is installed but is not ready. Run ${setupCommand} on that computer, then try again.`
            : 'The requested coding tool is not installed on that computer.',
          details: {
            requestedProvider: preference,
            ...(requestedDetection ? { requestedProviderStatus: requestedDetection.status } : {}),
            ...(setupCommand ? { setupCommand } : {}),
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
    const duplicate = this.startedJobForDuplicate(command.idempotencyKey);
    if (duplicate) return duplicate;
    const { payload } = command.command;
    const projectPath = this.options.projectRegistry.resolveProjectPath(payload.projectId);
    return this.withProjectStartLock(projectPath, async () => {
      const provider = await this.selectProvider(payload.providerPreference);

      const existing =
        payload.continueExistingSession === false
          ? null
          : this.options.store.findReusableSessionForProject(projectPath, provider.providerId, {
              userId: this.options.userId,
              deviceId: this.options.deviceId,
            });

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
    });
  }

  private async continueTask(command: DomainCommand): Promise<unknown> {
    if (command.command.name !== 'task.continue') {
      throw SoremaError.of('COMMAND_REJECTED', 'Unexpected command');
    }
    const duplicate = this.startedJobForDuplicate(command.idempotencyKey);
    if (duplicate) return duplicate;
    const { payload } = command.command;
    const stored = this.requireCodingSession(payload.domainSessionId);
    if (stored.archivedAt) {
      throw SoremaError.of('COMMAND_REJECTED', 'Restore this session before continuing it');
    }
    if (!stored.projectPath) throw SoremaError.of('PROJECT_NOT_FOUND', 'Session has no project');
    return this.withProjectStartLock(stored.projectPath, async () => {
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
    });
  }

  private startedJobForDuplicate(idempotencyKey: string): unknown | null {
    const duplicate = this.options.store.findJobByIdempotencyKey(idempotencyKey);
    if (!duplicate?.domainSessionId) return null;
    return {
      accepted: true as const,
      jobId: duplicate.id,
      domainSessionId: duplicate.domainSessionId,
      providerId: duplicate.providerId,
      domain: duplicate.domain,
      status: duplicate.status,
      spokenSummary: 'This task was already accepted.',
    };
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
    if (job.domainSessionId) this.markSessionIdle(job.domainSessionId);
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

function managedSessionFields(session: DomainSession) {
  return {
    id: session.id,
    domain: session.domain,
    providerId: session.providerId,
    title: session.title,
    status: session.status,
    archivedAt: session.archivedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function managedProjectFields(project: ProjectSummary) {
  return {
    id: project.id,
    name: project.name,
    isGitRepository: project.isGitRepository,
    lastModifiedAt: project.lastModifiedAt,
  };
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
