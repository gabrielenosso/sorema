import { SoremaError } from '@sorema/domain-model';

export type CommandRateLimiterOptions = {
  maxCommandsPerWindow: number;
  windowMs: number;
  maxConcurrentJobs: number;
};

export const DEFAULT_COMMAND_RATE_LIMITS: CommandRateLimiterOptions = {
  maxCommandsPerWindow: 60,
  windowMs: 60_000,
  maxConcurrentJobs: 4,
};

const JOB_STARTING_COMMANDS = new Set(['task.start', 'task.continue']);

/**
 * Last line of defence between a misbehaving model and the user's machine. The gateway already
 * validates and de-duplicates commands, but nothing upstream bounds how *often* they arrive, and a
 * looping model would otherwise be able to spawn coding processes without limit.
 */
export class CommandRateLimiter {
  private readonly options: CommandRateLimiterOptions;
  private readonly recentCommandTimestamps: number[] = [];

  constructor(options: CommandRateLimiterOptions = DEFAULT_COMMAND_RATE_LIMITS) {
    this.options = options;
  }

  check(commandName: string, activeJobCount: number, now: number = Date.now()): void {
    const windowStart = now - this.options.windowMs;
    while (
      this.recentCommandTimestamps.length > 0 &&
      this.recentCommandTimestamps[0]! <= windowStart
    ) {
      this.recentCommandTimestamps.shift();
    }

    if (this.recentCommandTimestamps.length >= this.options.maxCommandsPerWindow) {
      throw SoremaError.of(
        'COMMAND_REJECTED',
        `Rate limit reached: more than ${this.options.maxCommandsPerWindow} commands in ${this.options.windowMs}ms`,
        {
          retryable: true,
          userMessage: 'I am getting too many requests at once. Give me a moment and ask again.',
        },
      );
    }

    if (
      JOB_STARTING_COMMANDS.has(commandName) &&
      activeJobCount >= this.options.maxConcurrentJobs
    ) {
      throw SoremaError.of(
        'COMMAND_REJECTED',
        `Refusing to start another task: ${activeJobCount} are already running`,
        {
          retryable: true,
          userMessage:
            'There are already several tasks running on your computer. Let me finish those first.',
          details: { activeJobCount },
        },
      );
    }

    this.recentCommandTimestamps.push(now);
  }
}
