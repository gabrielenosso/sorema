import { describe, expect, it } from 'vitest';
import {
  CommandRateLimiter,
  DEFAULT_COMMAND_RATE_LIMITS,
} from '../src/process/command-rate-limiter.js';

describe('command rate limiter', () => {
  it('allows normal traffic through untouched', () => {
    const limiter = new CommandRateLimiter();
    for (let index = 0; index < DEFAULT_COMMAND_RATE_LIMITS.maxCommandsPerWindow; index += 1) {
      expect(() => limiter.check('projects.list', 0)).not.toThrow();
    }
  });

  it('refuses a model that loops on the same command', () => {
    const limiter = new CommandRateLimiter({
      maxCommandsPerWindow: 3,
      windowMs: 60_000,
      maxConcurrentJobs: 10,
    });
    limiter.check('projects.list', 0, 1_000);
    limiter.check('projects.list', 0, 1_100);
    limiter.check('projects.list', 0, 1_200);
    expect(() => limiter.check('projects.list', 0, 1_300)).toThrow(/rate limit/i);
  });

  it('forgives once the window has moved on', () => {
    const limiter = new CommandRateLimiter({
      maxCommandsPerWindow: 2,
      windowMs: 1_000,
      maxConcurrentJobs: 10,
    });
    limiter.check('projects.list', 0, 1_000);
    limiter.check('projects.list', 0, 1_100);
    expect(() => limiter.check('projects.list', 0, 1_200)).toThrow();
    expect(() => limiter.check('projects.list', 0, 2_500)).not.toThrow();
  });

  it('refuses to start yet another coding task when several already run', () => {
    const limiter = new CommandRateLimiter({
      maxCommandsPerWindow: 100,
      windowMs: 60_000,
      maxConcurrentJobs: 2,
    });
    expect(() => limiter.check('task.start', 2)).toThrow(/already running/i);
    expect(() => limiter.check('task.continue', 5)).toThrow(/already running/i);
  });

  it('still answers read-only questions while the job limit is reached', () => {
    const limiter = new CommandRateLimiter({
      maxCommandsPerWindow: 100,
      windowMs: 60_000,
      maxConcurrentJobs: 1,
    });
    expect(() => limiter.check('projects.list', 9)).not.toThrow();
    expect(() => limiter.check('job.status', 9)).not.toThrow();
    expect(() => limiter.check('job.cancel', 9)).not.toThrow();
  });

  it('gives the assistant something safe to say instead of a stack trace', () => {
    const limiter = new CommandRateLimiter({
      maxCommandsPerWindow: 1,
      windowMs: 60_000,
      maxConcurrentJobs: 1,
    });
    limiter.check('projects.list', 0, 1_000);
    try {
      limiter.check('projects.list', 0, 1_100);
      expect.unreachable('should have thrown');
    } catch (error) {
      const structured = (error as { structured: { userMessage: string; retryable: boolean } })
        .structured;
      expect(structured.userMessage).not.toMatch(/rate limit|window|ms/i);
      expect(structured.retryable).toBe(true);
    }
  });
});
