import { z } from 'zod';

export const notificationKindSchema = z.enum([
  'job_completed',
  'job_failed',
  'job_cancelled',
  'approval_required',
  'device_status',
]);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  kind: notificationKindSchema,
  title: z.string(),
  spokenSummary: z.string(),
  jobId: z.string().optional(),
  domainSessionId: z.string().optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
  announcedAt: z.string().optional(),
});

export type Notification = z.infer<typeof notificationSchema>;
