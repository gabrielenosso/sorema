import { z } from 'zod';

export const capabilityStatusSchema = z.enum(['ready', 'missing', 'misconfigured', 'unsupported']);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const capabilitySchema = z.object({
  id: z.string(),
  domain: z.string(),
  providerId: z.string().optional(),
  version: z.string().optional(),
  available: z.boolean(),
  status: capabilityStatusSchema,
  details: z.record(z.unknown()).optional(),
});

export type Capability = z.infer<typeof capabilitySchema>;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  isGitRepository: z.boolean(),
  lastModifiedAt: z.string().optional(),
});

export type ProjectSummary = z.infer<typeof projectSummarySchema>;
