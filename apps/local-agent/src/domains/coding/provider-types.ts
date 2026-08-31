import type { CapabilityStatus, StructuredError } from '@sorema/domain-model';

export type ProviderDetectionResult = {
  providerId: string;
  available: boolean;
  status: CapabilityStatus;
  version?: string;
  details?: Record<string, unknown>;
};

export type CodingSession = {
  providerId: string;
  providerSessionId?: string;
  projectPath: string;
  title: string;
  metadata: Record<string, unknown>;
};

/**
 * A session the coding agent already holds in its own store, from work the person started in its
 * desktop application rather than through Sorema.
 */
export type ExistingCodingSession = {
  providerSessionId: string;
  /**
   * Where the agent says the session was working. It travels because the answer may be about the
   * whole machine, and because an agent's own store covers the whole disk: what comes back has to
   * be checked against the roots the person authorised before any of it is offered.
   */
  projectPath: string;
  title: string;
  lastActiveAt: string;
};

export type ListExistingCodingSessionsInput = {
  /** Omitted when the question was about the machine rather than about one folder. */
  projectPath?: string;
  limit: number;
};

export type CreateCodingSessionInput = {
  projectPath: string;
  title: string;
};

export type ResumeCodingSessionInput = {
  providerSessionId?: string;
  projectPath: string;
  title: string;
  metadata?: Record<string, unknown>;
};

export type CodingTaskUpdate =
  | { kind: 'started'; providerSessionId?: string }
  | { kind: 'session_identified'; providerSessionId: string }
  | { kind: 'progress'; progress: number; message: string }
  | {
      kind: 'completed';
      summary: string;
      spokenSummary: string;
      details?: Record<string, unknown>;
    }
  | { kind: 'failed'; error: StructuredError };

export type SendCodingTaskInput = {
  jobId: string;
  session: CodingSession;
  instruction: string;
  onUpdate: (update: CodingTaskUpdate) => void;
};

export type CodingJob = {
  jobId: string;
  providerId: string;
  status: 'running';
};

export type CodingJobStatus = {
  jobId: string;
  running: boolean;
};

export interface CodingProvider {
  readonly providerId: string;
  detect(): Promise<ProviderDetectionResult>;
  /**
   * Sessions this agent already has for the project, newest first. An agent that keeps no readable
   * store of its own answers with an empty list rather than failing the call.
   */
  listExistingSessions(input: ListExistingCodingSessionsInput): Promise<ExistingCodingSession[]>;
  createSession(input: CreateCodingSessionInput): Promise<CodingSession>;
  resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession>;
  sendTask(input: SendCodingTaskInput): Promise<CodingJob>;
  cancelTask(jobId: string): Promise<void>;
  getTaskStatus(jobId: string): Promise<CodingJobStatus>;
}
