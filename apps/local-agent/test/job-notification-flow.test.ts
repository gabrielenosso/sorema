import { describe, expect, it } from 'vitest';
import { soremaEventSchema, type SoremaEvent } from '@sorema/domain-model';
import { jobUpdateForCloud } from '../src/agent.js';

function event(type: SoremaEvent['type'], payload: Record<string, unknown>): SoremaEvent {
  return soremaEventSchema.parse({
    eventId: `event-${type}`,
    occurredAt: '2026-08-18T08:00:00.000Z',
    userId: 'user-1',
    deviceId: 'device-1',
    correlationId: 'correlation-1',
    type,
    payload: {
      jobId: 'job-1',
      domain: 'coding',
      domainSessionId: 'session-1',
      conversationId: 'conversation-1',
      ...payload,
    },
  });
}

describe('reporting coding task activity to the notification system', () => {
  it.each([
    [
      'job.completed',
      {
        summary: 'Full completion with implementation details.',
        spokenSummary: 'Implemented the requested change.',
        completedAt: '2026-08-18T08:01:00.000Z',
      },
      {
        eventId: 'event-job.completed',
        eventType: 'job.completed',
        occurredAt: '2026-08-18T08:00:00.000Z',
        jobId: 'job-1',
        domainSessionId: 'session-1',
        status: 'succeeded',
        // Both, since they answer different questions. Sending only the spoken sentence is how a
        // whole review reached the user as its first paragraph.
        summary: 'Full completion with implementation details.',
        spokenSummary: 'Implemented the requested change.',
      },
    ],
    [
      'job.failed',
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'technical provider failure',
          userMessage: 'Claude stopped before completing the work.',
          retryable: true,
        },
        completedAt: '2026-08-18T08:01:00.000Z',
      },
      {
        eventId: 'event-job.failed',
        eventType: 'job.failed',
        occurredAt: '2026-08-18T08:00:00.000Z',
        jobId: 'job-1',
        domainSessionId: 'session-1',
        status: 'failed',
        summary: 'Claude stopped before completing the work.',
      },
    ],
    [
      'job.cancelled',
      {
        reason: 'Stopped at the user request.',
        completedAt: '2026-08-18T08:01:00.000Z',
      },
      {
        eventId: 'event-job.cancelled',
        eventType: 'job.cancelled',
        occurredAt: '2026-08-18T08:00:00.000Z',
        jobId: 'job-1',
        domainSessionId: 'session-1',
        status: 'cancelled',
        summary: 'Stopped at the user request.',
      },
    ],
  ] as const)('turns %s into one terminal cloud result', (type, payload, expected) => {
    expect(jobUpdateForCloud(event(type, payload))).toEqual(expected);
  });

  it('reports accepted and running states without pretending they are terminal results', () => {
    expect(
      jobUpdateForCloud(
        event('job.queued', { type: 'coding.task', idempotencyKey: 'idempotency-1' }),
      ),
    ).toEqual({
      eventId: 'event-job.queued',
      eventType: 'job.queued',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'job-1',
      domainSessionId: 'session-1',
      status: 'queued',
      summary: '',
    });
    expect(
      jobUpdateForCloud(event('job.started', { startedAt: '2026-08-18T08:00:01.000Z' })),
    ).toEqual({
      eventId: 'event-job.started',
      eventType: 'job.started',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'job-1',
      domainSessionId: 'session-1',
      status: 'running',
      summary: '',
    });
  });

  it('reports a coding-agent question as an actionable cloud notification', () => {
    expect(
      jobUpdateForCloud(
        event('approval.required', {
          action: 'Run the database migration',
          reason: 'It changes production data.',
          spokenSummary: 'The coding agent needs approval to run the database migration.',
        }),
      ),
    ).toEqual({
      eventId: 'event-approval.required',
      eventType: 'approval.required',
      occurredAt: '2026-08-18T08:00:00.000Z',
      jobId: 'job-1',
      domainSessionId: 'session-1',
      status: 'waiting_for_approval',
      summary: 'The coding agent needs approval to run the database migration.',
    });
  });

  it('does not turn high-frequency progress into conversation interruptions', () => {
    expect(
      jobUpdateForCloud(
        event('job.progress', { progress: 0.5, message: 'Reading another source file.' }),
      ),
    ).toBeNull();
  });
});
