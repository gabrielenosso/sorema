function randomIdentifierBody(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export function createIdentifier(prefix: string): string {
  return `${prefix}_${randomIdentifierBody()}`;
}

export function createCorrelationId(): string {
  return createIdentifier('corr');
}

export function createEventId(): string {
  return createIdentifier('evt');
}

export function createMessageId(): string {
  return createIdentifier('msg');
}

export function createJobId(): string {
  return createIdentifier('job');
}

export function createDomainSessionId(): string {
  return createIdentifier('dsn');
}

export function createNotificationId(): string {
  return createIdentifier('ntf');
}

export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
