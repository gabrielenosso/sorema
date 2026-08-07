import { z } from 'zod';
import { capabilitySchema, soremaEventSchema, structuredErrorSchema } from '@sorema/domain-model';
import { deviceCommandSchema } from './commands.js';

export const PROTOCOL_VERSION = '1.0.0';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

const envelopeShape = {
  messageId: z.string(),
  protocolVersion: z.string(),
  correlationId: z.string(),
  timestamp: z.string(),
  expiresAt: z.string().optional(),
  userId: z.string().optional(),
  deviceId: z.string().optional(),
};

function defineMessage<TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) {
  return z.object({ ...envelopeShape, type: z.literal(type), payload });
}

export const registerDeviceMessageSchema = defineMessage(
  'register_device',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    publicKeyPem: z.string(),
    agentVersion: z.string(),
    platform: z.string(),
    capabilities: z.array(capabilitySchema),
  }),
);

export const authenticationChallengeMessageSchema = defineMessage(
  'authentication_challenge',
  z.object({ challenge: z.string(), expiresAt: z.string() }),
);

export const authenticationResponseMessageSchema = defineMessage(
  'authentication_response',
  z.object({ challenge: z.string(), signature: z.string() }),
);

export const authenticationAcceptedMessageSchema = defineMessage(
  'authentication_accepted',
  z.object({
    deviceId: z.string(),
    userId: z.string(),
    sessionToken: z.string(),
    sessionTokenExpiresAtSeconds: z.number(),
    heartbeatIntervalMs: z.number(),
  }),
);

export const commandRequestMessageSchema = defineMessage(
  'command_request',
  z.object({ command: deviceCommandSchema, idempotencyKey: z.string() }),
);

export const commandAcceptedMessageSchema = defineMessage(
  'command_accepted',
  z.object({ requestMessageId: z.string() }),
);

export const commandResultMessageSchema = defineMessage(
  'command_result',
  z.object({
    requestMessageId: z.string(),
    commandName: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: structuredErrorSchema.optional(),
  }),
);

export const eventMessageSchema = defineMessage('event', z.object({ event: soremaEventSchema }));

export const ackMessageSchema = defineMessage(
  'ack',
  z.object({ acknowledgedMessageId: z.string(), acknowledgedEventId: z.string().optional() }),
);

export const heartbeatMessageSchema = defineMessage(
  'heartbeat',
  z.object({ uptimeSeconds: z.number(), activeJobCount: z.number() }),
);

export const errorMessageSchema = defineMessage(
  'error',
  z.object({ error: structuredErrorSchema, requestMessageId: z.string().optional() }),
);

export const tunnelMessageSchema = z.discriminatedUnion('type', [
  registerDeviceMessageSchema,
  authenticationChallengeMessageSchema,
  authenticationResponseMessageSchema,
  authenticationAcceptedMessageSchema,
  commandRequestMessageSchema,
  commandAcceptedMessageSchema,
  commandResultMessageSchema,
  eventMessageSchema,
  ackMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
]);

export type TunnelMessage = z.infer<typeof tunnelMessageSchema>;
export type TunnelMessageType = TunnelMessage['type'];

export type RegisterDeviceMessage = z.infer<typeof registerDeviceMessageSchema>;
export type AuthenticationChallengeMessage = z.infer<typeof authenticationChallengeMessageSchema>;
export type AuthenticationResponseMessage = z.infer<typeof authenticationResponseMessageSchema>;
export type AuthenticationAcceptedMessage = z.infer<typeof authenticationAcceptedMessageSchema>;
export type CommandRequestMessage = z.infer<typeof commandRequestMessageSchema>;
export type CommandAcceptedMessage = z.infer<typeof commandAcceptedMessageSchema>;
export type CommandResultMessage = z.infer<typeof commandResultMessageSchema>;
export type EventMessage = z.infer<typeof eventMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export function isProtocolVersionSupported(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

export function parseTunnelMessage(raw: string | Buffer): TunnelMessage {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return tunnelMessageSchema.parse(JSON.parse(text));
}

export function safeParseTunnelMessage(
  raw: string | Buffer,
): { success: true; message: TunnelMessage } | { success: false; reason: string } {
  try {
    return { success: true, message: parseTunnelMessage(raw) };
  } catch (error) {
    return { success: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeTunnelMessage(message: TunnelMessage): string {
  return JSON.stringify(message);
}

export function isMessageExpired(
  message: TunnelMessage,
  nowMilliseconds: number = Date.now(),
): boolean {
  if (!message.expiresAt) return false;
  return Date.parse(message.expiresAt) <= nowMilliseconds;
}
