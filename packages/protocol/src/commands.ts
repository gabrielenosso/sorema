import { z } from 'zod';
import {
  capabilitySchema,
  domainSessionSchema,
  jobSchema,
  jobStatusSchema,
  projectSummarySchema,
} from '@sorema/domain-model';

/**
 * Deliberately an open string, not an enum. Which providers exist is a property of the machine the
 * local agent runs on, discovered at runtime through capability detection. Closing this list here
 * would mean editing a shared package every time someone installs a different agent.
 */
export const providerPreferenceSchema = z.string().min(1);
export type ProviderPreference = z.infer<typeof providerPreferenceSchema>;

export const listCapabilitiesCommandSchema = z.object({
  name: z.literal('capabilities.list'),
  payload: z.object({}),
});

export const listProjectsCommandSchema = z.object({
  name: z.literal('projects.list'),
  payload: z.object({ search: z.string().optional() }),
});

export const createProjectCommandSchema = z.object({
  name: z.literal('projects.create'),
  payload: z.object({ name: z.string().min(1), workspaceRootPath: z.string().optional() }),
});

export const listDomainSessionsCommandSchema = z.object({
  name: z.literal('domain_sessions.list'),
  payload: z.object({ domain: z.string().optional(), projectPath: z.string().optional() }),
});

export const startTaskCommandSchema = z.object({
  name: z.literal('task.start'),
  payload: z.object({
    projectId: z.string(),
    instruction: z.string().min(1),
    domain: z.string().optional(),
    providerPreference: providerPreferenceSchema.optional(),
    continueExistingSession: z.boolean().optional(),
    conversationId: z.string().optional(),
  }),
});

export const continueTaskCommandSchema = z.object({
  name: z.literal('task.continue'),
  payload: z.object({
    domainSessionId: z.string(),
    instruction: z.string().min(1),
    conversationId: z.string().optional(),
  }),
});

export const getJobStatusCommandSchema = z.object({
  name: z.literal('job.status'),
  payload: z.object({ jobId: z.string() }),
});

export const cancelJobCommandSchema = z.object({
  name: z.literal('job.cancel'),
  payload: z.object({ jobId: z.string(), confirmed: z.boolean(), reason: z.string().optional() }),
});

export const listJobsCommandSchema = z.object({
  name: z.literal('jobs.list'),
  payload: z.object({ activeOnly: z.boolean().optional() }),
});

export const deviceCommandSchema = z.discriminatedUnion('name', [
  listCapabilitiesCommandSchema,
  listProjectsCommandSchema,
  createProjectCommandSchema,
  listDomainSessionsCommandSchema,
  startTaskCommandSchema,
  continueTaskCommandSchema,
  getJobStatusCommandSchema,
  cancelJobCommandSchema,
  listJobsCommandSchema,
]);

export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export type DeviceCommandName = DeviceCommand['name'];

export const startedJobResultSchema = z.object({
  accepted: z.literal(true),
  jobId: z.string(),
  domainSessionId: z.string(),
  domain: z.string(),
  providerId: z.string(),
  status: jobStatusSchema,
  spokenSummary: z.string(),
});

export type StartedJobResult = z.infer<typeof startedJobResultSchema>;

export const deviceCommandResultSchemasByName = {
  'capabilities.list': z.object({ capabilities: z.array(capabilitySchema) }),
  'projects.list': z.object({ projects: z.array(projectSummarySchema) }),
  'projects.create': z.object({ project: projectSummarySchema, alreadyExisted: z.boolean() }),
  'domain_sessions.list': z.object({ sessions: z.array(domainSessionSchema) }),
  'task.start': startedJobResultSchema,
  'task.continue': startedJobResultSchema,
  'job.status': z.object({ job: jobSchema }),
  'job.cancel': z.object({ jobId: z.string(), cancelled: z.boolean(), status: jobStatusSchema }),
  'jobs.list': z.object({ jobs: z.array(jobSchema) }),
} as const;

export type DeviceCommandResultByName = {
  [TName in DeviceCommandName]: z.infer<(typeof deviceCommandResultSchemasByName)[TName]>;
};

export type DeviceCommandResult = DeviceCommandResultByName[DeviceCommandName];

export function parseDeviceCommandResult<TName extends DeviceCommandName>(
  name: TName,
  value: unknown,
): DeviceCommandResultByName[TName] {
  return deviceCommandResultSchemasByName[name].parse(value) as DeviceCommandResultByName[TName];
}
