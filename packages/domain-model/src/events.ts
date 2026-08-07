import { z } from 'zod';
import { structuredErrorSchema } from './errors.js';
import { jobStatusSchema } from './job.js';
import { domainSessionSchema } from './domain-session.js';
import { capabilitySchema } from './capability.js';
import { notificationSchema } from './notification.js';

const eventEnvelopeShape = {
  eventId: z.string(),
  occurredAt: z.string(),
  userId: z.string(),
  deviceId: z.string().optional(),
  correlationId: z.string(),
  causationId: z.string().optional(),
};

function defineEvent<TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) {
  return z.object({ ...eventEnvelopeShape, type: z.literal(type), payload });
}

const jobReferencePayload = {
  jobId: z.string(),
  domain: z.string(),
  domainSessionId: z.string().optional(),
  conversationId: z.string().optional(),
};

export const jobQueuedEventSchema = defineEvent(
  'job.queued',
  z.object({ ...jobReferencePayload, type: z.string(), idempotencyKey: z.string() }),
);

export const jobStartedEventSchema = defineEvent(
  'job.started',
  z.object({ ...jobReferencePayload, startedAt: z.string() }),
);

export const jobProgressEventSchema = defineEvent(
  'job.progress',
  z.object({ ...jobReferencePayload, progress: z.number().min(0).max(1), message: z.string() }),
);

export const jobCompletedEventSchema = defineEvent(
  'job.completed',
  z.object({
    ...jobReferencePayload,
    summary: z.string(),
    spokenSummary: z.string(),
    completedAt: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
);

export const jobFailedEventSchema = defineEvent(
  'job.failed',
  z.object({ ...jobReferencePayload, error: structuredErrorSchema, completedAt: z.string() }),
);

export const jobCancelledEventSchema = defineEvent(
  'job.cancelled',
  z.object({ ...jobReferencePayload, reason: z.string(), completedAt: z.string() }),
);

export const approvalRequiredEventSchema = defineEvent(
  'approval.required',
  z.object({
    ...jobReferencePayload,
    action: z.string(),
    reason: z.string(),
    spokenSummary: z.string(),
  }),
);

export const deviceOnlineEventSchema = defineEvent(
  'device.online',
  z.object({ deviceName: z.string(), capabilities: z.array(capabilitySchema) }),
);

export const deviceOfflineEventSchema = defineEvent(
  'device.offline',
  z.object({ deviceName: z.string(), reason: z.string() }),
);

export const domainSessionCreatedEventSchema = defineEvent(
  'domain_session.created',
  z.object({ session: domainSessionSchema }),
);

export const domainSessionResumedEventSchema = defineEvent(
  'domain_session.resumed',
  z.object({ session: domainSessionSchema }),
);

export const notificationCreatedEventSchema = defineEvent(
  'notification.created',
  z.object({ notification: notificationSchema }),
);

export const soremaEventSchema = z.discriminatedUnion('type', [
  jobQueuedEventSchema,
  jobStartedEventSchema,
  jobProgressEventSchema,
  jobCompletedEventSchema,
  jobFailedEventSchema,
  jobCancelledEventSchema,
  approvalRequiredEventSchema,
  deviceOnlineEventSchema,
  deviceOfflineEventSchema,
  domainSessionCreatedEventSchema,
  domainSessionResumedEventSchema,
  notificationCreatedEventSchema,
]);

export type SoremaEvent = z.infer<typeof soremaEventSchema>;
export type SoremaEventType = SoremaEvent['type'];

export type JobQueuedEvent = z.infer<typeof jobQueuedEventSchema>;
export type JobStartedEvent = z.infer<typeof jobStartedEventSchema>;
export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;
export type JobCompletedEvent = z.infer<typeof jobCompletedEventSchema>;
export type JobFailedEvent = z.infer<typeof jobFailedEventSchema>;
export type JobCancelledEvent = z.infer<typeof jobCancelledEventSchema>;
export type ApprovalRequiredEvent = z.infer<typeof approvalRequiredEventSchema>;
export type DeviceOnlineEvent = z.infer<typeof deviceOnlineEventSchema>;
export type DeviceOfflineEvent = z.infer<typeof deviceOfflineEventSchema>;
export type DomainSessionCreatedEvent = z.infer<typeof domainSessionCreatedEventSchema>;
export type DomainSessionResumedEvent = z.infer<typeof domainSessionResumedEventSchema>;
export type NotificationCreatedEvent = z.infer<typeof notificationCreatedEventSchema>;

export const JOB_STATUS_BY_EVENT_TYPE: Partial<
  Record<SoremaEventType, z.infer<typeof jobStatusSchema>>
> = {
  'job.queued': 'queued',
  'job.started': 'running',
  'job.completed': 'completed',
  'job.failed': 'failed',
  'job.cancelled': 'cancelled',
  'approval.required': 'waiting_for_approval',
};
