import { pino, type Logger, type LoggerOptions } from 'pino';

export type LogContext = {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  deviceId?: string;
  conversationId?: string;
  realtimeCallId?: string;
  jobId?: string;
  domainSessionId?: string;
};

export const REDACTED_LOG_PATHS = [
  'apiKey',
  'openAiApiKey',
  'token',
  'accessToken',
  'clientToken',
  'deviceToken',
  'privateKey',
  'secret',
  'password',
  'authorization',
  'headers.authorization',
  '*.apiKey',
  '*.token',
  '*.privateKey',
  '*.secret',
  'payload.env',
  'payload.fileContents',
  'audio',
  'delta',
];

export function createLogger(
  name: string,
  level: LoggerOptions['level'] = 'info',
  pretty = process.env.NODE_ENV !== 'production',
): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export function withLogContext(logger: Logger, context: LogContext): Logger {
  const defined = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
  return logger.child(defined);
}

export type { Logger };
