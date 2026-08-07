import { z } from 'zod';
import { structuredErrorSchema } from './errors.js';

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export const jobSchema = z.object({
  id: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  conversationId: z.string().optional(),
  domainSessionId: z.string().optional(),
  domain: z.string(),
  type: z.string(),
  status: jobStatusSchema,
  progress: z.number().min(0).max(1).optional(),
  summary: z.string().optional(),
  error: structuredErrorSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  idempotencyKey: z.string(),
  correlationId: z.string(),
});

export type Job = z.infer<typeof jobSchema>;
