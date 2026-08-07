import { z } from 'zod';

export const memoryThreadStatusSchema = z.enum(['active', 'archived']);
export type MemoryThreadStatus = z.infer<typeof memoryThreadStatusSchema>;

/**
 * A subject the user cares about, remembered across conversations, devices and restarts.
 *
 * A thread is deliberately not tied to a project, a domain or a machine. "my back pain", "the tax
 * return" and "the Sorema repo" are all threads. Links to a project or a domain are optional
 * hints, not the identity of the thing.
 */
export const memoryThreadSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  domain: z.string().optional(),
  projectId: z.string().optional(),
  status: memoryThreadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastDiscussedAt: z.string(),
});

export type MemoryThread = z.infer<typeof memoryThreadSchema>;

export const memoryEntrySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  userId: z.string(),
  text: z.string(),
  occurredAt: z.string(),
  conversationId: z.string().optional(),
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const recalledThreadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  summary: z.string(),
  lastDiscussedAt: z.string(),
  score: z.number(),
  recentEntries: z.array(z.object({ text: z.string(), occurredAt: z.string() })),
});

export type RecalledThread = z.infer<typeof recalledThreadSchema>;
