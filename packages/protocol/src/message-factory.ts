import { createMessageId, nowIsoTimestamp } from '@sorema/domain-model';
import { PROTOCOL_VERSION, type TunnelMessage } from './tunnel.js';

type MessageDraft<TMessage extends TunnelMessage> = Pick<TMessage, 'type' | 'payload'> &
  Partial<Pick<TunnelMessage, 'userId' | 'deviceId' | 'correlationId' | 'expiresAt'>>;

export function createTunnelMessage<TMessage extends TunnelMessage>(
  draft: MessageDraft<TMessage>,
): TMessage {
  return {
    messageId: createMessageId(),
    protocolVersion: PROTOCOL_VERSION,
    correlationId: draft.correlationId ?? createMessageId(),
    timestamp: nowIsoTimestamp(),
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
    ...(draft.userId ? { userId: draft.userId } : {}),
    ...(draft.deviceId ? { deviceId: draft.deviceId } : {}),
    type: draft.type,
    payload: draft.payload,
  } as TMessage;
}

export function expiresInMilliseconds(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}
