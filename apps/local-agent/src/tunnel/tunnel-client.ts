import WebSocket from 'ws';
import {
  SoremaError,
  createCorrelationId,
  nowIsoTimestamp,
  toStructuredError,
  type SoremaEvent,
} from '@sorema/domain-model';
import {
  createTunnelMessage,
  isMessageExpired,
  isProtocolVersionSupported,
  safeParseTunnelMessage,
  serializeTunnelMessage,
  type CommandRequestMessage,
  type TunnelMessage,
} from '@sorema/protocol';
import { METRIC_NAMES, type Logger, type MetricsRegistry } from '@sorema/observability';
import type { DeviceIdentityStore } from '../identity/device-identity-store.js';
import type { LocalStore } from '../store/local-store.js';

export type CommandHandler = (message: CommandRequestMessage) => Promise<unknown>;

export type TunnelClientOptions = {
  gatewayTunnelUrl: string;
  identity: DeviceIdentityStore;
  store: LocalStore;
  logger: Logger;
  metrics: MetricsRegistry;
  deviceName: string;
  agentVersion: string;
  platform: string;
  getCapabilities: () => Promise<import('@sorema/domain-model').Capability[]>;
  handleCommand: CommandHandler;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  heartbeatIntervalMs: number;
  outboxFlushIntervalMs: number;
  createSocket?: (url: string) => WebSocket;
};

export class TunnelClient {
  private readonly options: TunnelClientOptions;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private stopping = false;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  constructor(options: TunnelClientOptions) {
    this.options = options;
    this.reconnectDelayMs = options.reconnectInitialDelayMs;
  }

  get isAuthenticated(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopping = false;
    this.connect();
    this.outboxTimer = setInterval(() => this.flushOutbox(), this.options.outboxFlushIntervalMs);
    this.outboxTimer.unref?.();
  }

  private connect(): void {
    const { identity, logger } = this.options;
    if (!identity.isPaired) {
      logger.warn(
        'local agent is not paired yet; run the pairing command before connecting to the gateway',
      );
      this.scheduleReconnect();
      return;
    }

    const socket = this.options.createSocket
      ? this.options.createSocket(this.options.gatewayTunnelUrl)
      : new WebSocket(this.options.gatewayTunnelUrl);
    this.socket = socket;

    socket.on('open', () => {
      logger.info('tunnel connected, registering device');
      void this.sendRegistration();
    });

    socket.on('message', (raw: Buffer) => void this.handleMessage(raw));

    socket.on('close', (code: number, reason: Buffer) => {
      this.authenticated = false;
      this.stopHeartbeat();
      logger.warn({ code, reason: reason.toString() }, 'tunnel disconnected');
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      logger.warn({ error: error.message }, 'tunnel socket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.options.metrics.incrementCounter(METRIC_NAMES.tunnelReconnections);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.options.reconnectMaxDelayMs);
  }

  private async sendRegistration(): Promise<void> {
    const { identity } = this.options;
    const capabilities = await this.options.getCapabilities();
    this.send(
      createTunnelMessage({
        type: 'register_device',
        correlationId: createCorrelationId(),
        deviceId: identity.deviceId ?? undefined,
        userId: identity.userId ?? undefined,
        payload: {
          deviceId: identity.deviceId ?? '',
          deviceName: this.options.deviceName,
          publicKeyPem: identity.publicKeyPem,
          agentVersion: this.options.agentVersion,
          platform: this.options.platform,
          capabilities,
        },
      }),
    );
  }

  private async handleMessage(raw: Buffer): Promise<void> {
    const parsed = safeParseTunnelMessage(raw);
    if (!parsed.success) {
      this.options.logger.warn({ reason: parsed.reason }, 'ignored malformed gateway message');
      return;
    }
    const message = parsed.message;

    if (!isProtocolVersionSupported(message.protocolVersion)) {
      this.options.logger.error(
        { protocolVersion: message.protocolVersion },
        'gateway speaks an unsupported protocol version',
      );
      return;
    }
    if (isMessageExpired(message)) {
      this.options.logger.warn({ messageId: message.messageId }, 'dropped expired gateway message');
      return;
    }

    switch (message.type) {
      case 'authentication_challenge':
        this.send(
          createTunnelMessage({
            type: 'authentication_response',
            correlationId: message.correlationId,
            deviceId: this.options.identity.deviceId ?? undefined,
            userId: this.options.identity.userId ?? undefined,
            payload: {
              challenge: message.payload.challenge,
              signature: this.options.identity.sign(message.payload.challenge),
            },
          }),
        );
        return;
      case 'authentication_accepted':
        this.authenticated = true;
        this.reconnectDelayMs = this.options.reconnectInitialDelayMs;
        this.options.logger.info(
          { deviceId: message.payload.deviceId },
          'local agent authenticated with the gateway',
        );
        this.startHeartbeat(message.payload.heartbeatIntervalMs);
        this.flushOutbox();
        return;
      case 'command_request':
        await this.executeCommand(message);
        return;
      case 'ack':
        if (message.payload.acknowledgedEventId) {
          this.options.store.acknowledgeOutboxEvent(message.payload.acknowledgedEventId);
        }
        return;
      case 'error':
        this.options.logger.error(
          { code: message.payload.error.code, message: message.payload.error.message },
          'gateway reported an error',
        );
        return;
      default:
        return;
    }
  }

  private async executeCommand(message: CommandRequestMessage): Promise<void> {
    const { store, logger } = this.options;
    const cached = store.findProcessedCommand(message.payload.idempotencyKey);
    if (cached !== null) {
      logger.info(
        { idempotencyKey: message.payload.idempotencyKey },
        'replaying cached result for duplicate command',
      );
      this.sendCommandResult(message, true, cached, undefined);
      return;
    }

    this.send(
      createTunnelMessage({
        type: 'command_accepted',
        correlationId: message.correlationId,
        deviceId: this.options.identity.deviceId ?? undefined,
        userId: this.options.identity.userId ?? undefined,
        payload: { requestMessageId: message.messageId },
      }),
    );

    try {
      const result = await this.options.handleCommand(message);
      store.recordProcessedCommand(
        message.payload.idempotencyKey,
        message.payload.command.name,
        result,
      );
      this.sendCommandResult(message, true, result, undefined);
    } catch (error) {
      const structured = toStructuredError(error);
      logger.warn(
        { commandName: message.payload.command.name, code: structured.code },
        'command failed',
      );
      this.sendCommandResult(message, false, undefined, structured);
    }
  }

  private sendCommandResult(
    request: CommandRequestMessage,
    ok: boolean,
    result: unknown,
    error: ReturnType<typeof toStructuredError> | undefined,
  ): void {
    this.send(
      createTunnelMessage({
        type: 'command_result',
        correlationId: request.correlationId,
        deviceId: this.options.identity.deviceId ?? undefined,
        userId: this.options.identity.userId ?? undefined,
        payload: {
          requestMessageId: request.messageId,
          commandName: request.payload.command.name,
          ok,
          result,
          error,
        },
      }),
    );
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const effectiveInterval = intervalMs > 0 ? intervalMs : this.options.heartbeatIntervalMs;
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAuthenticated) return;
      this.send(
        createTunnelMessage({
          type: 'heartbeat',
          deviceId: this.options.identity.deviceId ?? undefined,
          userId: this.options.identity.userId ?? undefined,
          payload: {
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            activeJobCount: this.options.store.listJobs({ activeOnly: true }).length,
          },
        }),
      );
    }, effectiveInterval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  publishEvent(event: SoremaEvent): void {
    this.options.store.enqueueOutboxEvent(event);
    this.options.metrics.setGauge(
      METRIC_NAMES.outboxPending,
      this.options.store.countPendingOutboxEntries(),
    );
    this.flushOutbox();
  }

  flushOutbox(): void {
    // The interval can fire once more after stop() has run and the store has been closed, which
    // turns an ordinary shutdown into a thrown error about a database connection that is not open.
    if (this.stopping) return;
    this.options.metrics.setGauge(
      METRIC_NAMES.outboxPending,
      this.options.store.countPendingOutboxEntries(),
    );
    if (!this.isAuthenticated) return;
    for (const entry of this.options.store.listDueOutboxEntries()) {
      try {
        this.send(
          createTunnelMessage({
            type: 'event',
            correlationId: entry.event.correlationId,
            deviceId: this.options.identity.deviceId ?? undefined,
            userId: entry.event.userId,
            payload: { event: entry.event },
          }),
        );
        this.options.store.recordOutboxDeliveryAttempt(entry.eventId, entry.attempts);
      } catch (error) {
        this.options.logger.warn(
          { eventId: entry.eventId, error: error instanceof Error ? error.message : String(error) },
          'failed to deliver outbox event',
        );
        this.options.store.recordOutboxDeliveryAttempt(entry.eventId, entry.attempts);
      }
    }
  }

  private send(message: TunnelMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw SoremaError.of('LOCAL_AGENT_OFFLINE', 'The tunnel socket is not open');
    }
    this.socket.send(serializeTunnelMessage(message));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.outboxTimer = null;
    this.reconnectTimer = null;
    this.authenticated = false;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, 'local agent shutting down');
    }
    this.socket = null;
    await Promise.resolve();
  }

  describeStatus(): Record<string, unknown> {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      authenticated: this.authenticated,
      pendingOutboxEvents: this.options.store.countPendingOutboxEntries(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      lastCheckedAt: nowIsoTimestamp(),
    };
  }
}
