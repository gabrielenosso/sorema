import { z } from 'zod';

export const SOREMA_ERROR_CODES = [
  'LOCAL_AGENT_OFFLINE',
  'DEVICE_NOT_AUTHORIZED',
  'PROJECT_NOT_FOUND',
  'PROJECT_NOT_ALLOWED',
  'CODING_PROVIDER_NOT_INSTALLED',
  'PROVIDER_CHOICE_REQUIRED',
  'CODING_SESSION_NOT_FOUND',
  'JOB_NOT_FOUND',
  'JOB_ALREADY_COMPLETED',
  'TOOL_TIMEOUT',
  'REALTIME_SESSION_CLOSED',
  'OPENAI_CONNECTION_FAILED',
  'APPROVAL_REQUIRED',
  'COMMAND_REJECTED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'INTERNAL_ERROR',
] as const;

export const soremaErrorCodeSchema = z.enum(SOREMA_ERROR_CODES);
export type SoremaErrorCode = z.infer<typeof soremaErrorCodeSchema>;

export const structuredErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  userMessage: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type StructuredError = z.infer<typeof structuredErrorSchema>;

const ERROR_DEFAULTS: Record<SoremaErrorCode, { retryable: boolean; userMessage: string }> = {
  LOCAL_AGENT_OFFLINE: {
    retryable: true,
    userMessage: 'The computer running the agent is not reachable right now.',
  },
  DEVICE_NOT_AUTHORIZED: {
    retryable: false,
    userMessage: 'That device is not paired with this account.',
  },
  PROJECT_NOT_FOUND: { retryable: false, userMessage: 'I could not find that project.' },
  PROJECT_NOT_ALLOWED: {
    retryable: false,
    userMessage: 'That folder is outside the allowed workspaces.',
  },
  CODING_PROVIDER_NOT_INSTALLED: {
    retryable: false,
    userMessage: 'The requested coding tool is not installed on that computer.',
  },
  PROVIDER_CHOICE_REQUIRED: {
    retryable: false,
    userMessage: 'More than one agent can do this. Ask the user which one to use, then try again.',
  },
  CODING_SESSION_NOT_FOUND: {
    retryable: false,
    userMessage: 'I could not find that coding session anymore.',
  },
  JOB_NOT_FOUND: { retryable: false, userMessage: 'I could not find that task.' },
  JOB_ALREADY_COMPLETED: { retryable: false, userMessage: 'That task is already finished.' },
  TOOL_TIMEOUT: { retryable: true, userMessage: 'That took too long to respond.' },
  REALTIME_SESSION_CLOSED: { retryable: false, userMessage: 'The voice session has ended.' },
  OPENAI_CONNECTION_FAILED: {
    retryable: true,
    userMessage: 'I could not reach the voice service.',
  },
  APPROVAL_REQUIRED: { retryable: false, userMessage: 'That action needs your confirmation.' },
  COMMAND_REJECTED: { retryable: false, userMessage: 'That command was refused for safety.' },
  PROTOCOL_VERSION_UNSUPPORTED: {
    retryable: false,
    userMessage: 'The agent on that computer needs to be updated.',
  },
  INTERNAL_ERROR: { retryable: true, userMessage: 'Something went wrong on my side.' },
};

export function createStructuredError(
  code: SoremaErrorCode,
  message: string,
  options: { details?: Record<string, unknown>; userMessage?: string; retryable?: boolean } = {},
): StructuredError {
  const defaults = ERROR_DEFAULTS[code];
  return {
    code,
    message,
    retryable: options.retryable ?? defaults.retryable,
    userMessage: options.userMessage ?? defaults.userMessage,
    ...(options.details ? { details: options.details } : {}),
  };
}

export class SoremaError extends Error {
  readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = 'SoremaError';
    this.structured = structured;
  }

  static of(
    code: SoremaErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; userMessage?: string; retryable?: boolean } = {},
  ): SoremaError {
    return new SoremaError(createStructuredError(code, message, options));
  }
}

export function toStructuredError(cause: unknown): StructuredError {
  if (cause instanceof SoremaError) return cause.structured;
  const parsed = structuredErrorSchema.safeParse(cause);
  if (parsed.success) return parsed.data;
  const message = cause instanceof Error ? cause.message : String(cause);
  return createStructuredError('INTERNAL_ERROR', message);
}
