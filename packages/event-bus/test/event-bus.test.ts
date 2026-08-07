import { describe, expect, it, vi } from 'vitest';
import { createEventId, nowIsoTimestamp, type JobCompletedEvent } from '@sorema/domain-model';
import { InMemoryEventBus } from '../src/index.js';

function jobCompletedEvent(): JobCompletedEvent {
  return {
    eventId: createEventId(),
    type: 'job.completed',
    occurredAt: nowIsoTimestamp(),
    userId: 'user_1',
    correlationId: 'corr_1',
    payload: {
      jobId: 'job_1',
      domain: 'coding',
      summary: 'done',
      spokenSummary: 'done',
      completedAt: nowIsoTimestamp(),
    },
  };
}

describe('in-memory event bus', () => {
  it('delivers an event to typed subscribers only', async () => {
    const bus = new InMemoryEventBus();
    const completedHandler = vi.fn();
    const failedHandler = vi.fn();
    bus.subscribe('job.completed', completedHandler);
    bus.subscribe('job.failed', failedHandler);

    await bus.publish(jobCompletedEvent());

    expect(completedHandler).toHaveBeenCalledTimes(1);
    expect(failedHandler).not.toHaveBeenCalled();
  });

  it('delivers to wildcard subscribers', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.subscribeToAll(handler);
    await bus.publish(jobCompletedEvent());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('job.completed', handler);
    unsubscribe();
    await bus.publish(jobCompletedEvent());
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates a throwing handler from the others', async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus((error) => errors.push(error));
    const healthy = vi.fn();
    bus.subscribe('job.completed', () => {
      throw new Error('handler exploded');
    });
    bus.subscribe('job.completed', healthy);

    await bus.publish(jobCompletedEvent());

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('awaits asynchronous handlers before resolving', async () => {
    const bus = new InMemoryEventBus();
    let finished = false;
    bus.subscribe('job.completed', async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      finished = true;
    });
    await bus.publish(jobCompletedEvent());
    expect(finished).toBe(true);
  });
});
