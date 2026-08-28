import { describe, expect, it } from 'vitest';
import { jobUpdateForCloud } from '../src/agent.js';

/**
 * The whole review came back as one sentence, and the user said so: *"se la risposta c'è solo una
 * frase, mi sembra molto strano."*
 *
 * It was neither the coding agent nor the cloud. `buildSpokenSummary` keeps the first paragraph and
 * caps it at 320 characters, which is right for something read aloud — and this function then sent
 * that in place of the full text, so the long version never left the machine at all. The screen and
 * the voice were being given one field, and it was the short one.
 *
 * Both now travel. The voice keeps the sentence written to be spoken; the screen gets what the agent
 * actually wrote.
 */
describe('what a finished job sends to the cloud', () => {
  const completed = {
    type: 'job.completed',
    eventId: 'event-1',
    userId: 'user-1',
    correlationId: 'corr-1',
    occurredAt: '2026-08-27T10:00:00.000Z',
    payload: {
      domain: 'coding',
      jobId: 'job-1',
      domainSessionId: 'session-1',
      completedAt: '2026-08-27T10:00:00.000Z',
      summary: 'First paragraph.\n\nSecond paragraph, which is where the detail was.',
      spokenSummary: 'First paragraph.',
    },
  } as unknown as Parameters<typeof jobUpdateForCloud>[0];

  it('sends the full summary, not the spoken one', () => {
    expect(jobUpdateForCloud(completed)?.summary).toBe(
      'First paragraph.\n\nSecond paragraph, which is where the detail was.',
    );
  });

  it('sends the spoken sentence as well, so the voice still has one', () => {
    expect(jobUpdateForCloud(completed)?.spokenSummary).toBe('First paragraph.');
  });

  it('falls back to the full text when a provider wrote no spoken sentence', () => {
    const withoutSpoken = {
      ...completed,
      payload: { ...completed.payload, spokenSummary: '' },
    } as unknown as Parameters<typeof jobUpdateForCloud>[0];

    expect(jobUpdateForCloud(withoutSpoken)?.spokenSummary).toBe(
      'First paragraph.\n\nSecond paragraph, which is where the detail was.',
    );
  });
});
