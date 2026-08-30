import { z } from 'zod';
import {
  capabilitySchema,
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
  payload: z.object({
    domain: z.string().optional(),
    projectPath: z.string().optional(),
    includeArchived: z.boolean().optional(),
  }),
});

/**
 * Sessions the coding agents already hold for a project, from work started in their own desktop
 * applications rather than through Sorema. The answer is a list of Sorema sessions: a discovered
 * one is adopted before it is reported, so continuing it needs nothing new.
 */
export const discoverDomainSessionsCommandSchema = z.object({
  name: z.literal('domain_sessions.discover'),
  payload: z.object({ projectId: z.string().min(1) }),
});

export const renameDomainSessionCommandSchema = z.object({
  name: z.literal('domain_sessions.rename'),
  payload: z.object({
    domainSessionId: z.string().min(1),
    title: z.string().trim().min(1).max(120),
  }),
});

export const archiveDomainSessionCommandSchema = z.object({
  name: z.literal('domain_sessions.archive'),
  payload: z.object({ domainSessionId: z.string().min(1), archived: z.boolean() }),
});

export const startNewDomainSessionCommandSchema = z.object({
  name: z.literal('domain_sessions.start_new'),
  payload: z.object({
    domainSessionId: z.string().min(1),
    instruction: z.string().trim().min(1).max(20_000),
  }),
});

export const stopDomainSessionCommandSchema = z.object({
  name: z.literal('domain_sessions.stop'),
  payload: z.object({ domainSessionId: z.string().min(1), confirmed: z.literal(true) }),
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

/**
 * The two note commands, which exist only in the `tool` memory mode: the hosted service forwards
 * them here instead of answering them, so that what somebody asks to be remembered is written on
 * their own machine and nowhere else.
 */
export const rememberCommandSchema = z.object({
  name: z.literal('memory.remember'),
  payload: z.object({
    subject: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(4_000),
  }),
});

export const recallCommandSchema = z.object({
  name: z.literal('memory.recall'),
  payload: z.object({ query: z.string().trim().min(1).max(400) }),
});

export const deviceCommandSchema = z.discriminatedUnion('name', [
  listCapabilitiesCommandSchema,
  listProjectsCommandSchema,
  createProjectCommandSchema,
  listDomainSessionsCommandSchema,
  discoverDomainSessionsCommandSchema,
  renameDomainSessionCommandSchema,
  archiveDomainSessionCommandSchema,
  startNewDomainSessionCommandSchema,
  stopDomainSessionCommandSchema,
  startTaskCommandSchema,
  continueTaskCommandSchema,
  getJobStatusCommandSchema,
  cancelJobCommandSchema,
  listJobsCommandSchema,
  rememberCommandSchema,
  recallCommandSchema,
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

export const managedDomainSessionSchema = z.object({
  id: z.string(),
  domain: z.string(),
  providerId: z.string(),
  title: z.string(),
  status: z.string(),
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listedDomainSessionSchema = managedDomainSessionSchema.extend({
  projectId: z.string(),
  projectName: z.string(),
  activeJobId: z.string().optional(),
});

export const managedProjectSummarySchema = projectSummarySchema.pick({
  id: true,
  name: true,
  isGitRepository: true,
  lastModifiedAt: true,
});

export const deviceCommandResultSchemasByName = {
  'capabilities.list': z.object({ capabilities: z.array(capabilitySchema) }),
  'projects.list': z.object({ projects: z.array(managedProjectSummarySchema) }),
  'projects.create': z.object({
    project: managedProjectSummarySchema,
    alreadyExisted: z.boolean(),
  }),
  'domain_sessions.list': z.object({ sessions: z.array(listedDomainSessionSchema) }),
  'domain_sessions.discover': z.object({ sessions: z.array(managedDomainSessionSchema) }),
  'domain_sessions.rename': z.object({ session: managedDomainSessionSchema }),
  'domain_sessions.archive': z.object({ session: managedDomainSessionSchema }),
  'domain_sessions.start_new': startedJobResultSchema,
  'domain_sessions.stop': z.object({
    jobId: z.string(),
    cancelled: z.boolean(),
    status: jobStatusSchema,
  }),
  'task.start': startedJobResultSchema,
  'task.continue': startedJobResultSchema,
  'job.status': z.object({ job: jobSchema }),
  'job.cancel': z.object({ jobId: z.string(), cancelled: z.boolean(), status: jobStatusSchema }),
  'jobs.list': z.object({ jobs: z.array(jobSchema) }),
  'memory.remember': z.object({ title: z.string(), created: z.boolean() }),
  'memory.recall': z.object({
    threads: z.array(
      z.object({
        title: z.string(),
        recentEntries: z.array(z.object({ text: z.string(), occurredAt: z.string() })),
      }),
    ),
    spokenSummary: z.string(),
  }),
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
