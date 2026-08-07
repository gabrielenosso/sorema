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
  createSession(input: CreateCodingSessionInput): Promise<CodingSession>;
  resumeSession(input: ResumeCodingSessionInput): Promise<CodingSession>;
  sendTask(input: SendCodingTaskInput): Promise<CodingJob>;
  cancelTask(jobId: string): Promise<void>;
  getTaskStatus(jobId: string): Promise<CodingJobStatus>;
}
