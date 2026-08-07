import { z } from 'zod';

/**
 * The domains that exist today. This is a hint for humans reading the code, not a closed set: a
 * device can register an adapter for anything, and the assistant learns what is available from
 * capability discovery rather than from a list compiled into a shared package.
 */
export const KNOWN_DOMAIN_NAMES = ['coding', 'browser', 'productivity', 'system'] as const;

export const domainNameSchema = z.string().min(1);
export type DomainName = z.infer<typeof domainNameSchema>;

export const domainSessionStatusSchema = z.enum(['active', 'idle', 'closed', 'error']);
export type DomainSessionStatus = z.infer<typeof domainSessionStatusSchema>;

export const domainSessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  domain: domainNameSchema,
  providerId: z.string(),
  providerSessionId: z.string().optional(),
  projectPath: z.string().optional(),
  title: z.string(),
  status: domainSessionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.unknown()),
});

export type DomainSession = z.infer<typeof domainSessionSchema>;
