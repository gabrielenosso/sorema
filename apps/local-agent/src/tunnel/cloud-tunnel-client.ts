import { toStructuredError } from '@sorema/domain-model';
import type { DeviceIdentityStore } from '../identity/device-identity-store.js';

export type CloudCommand = { name: string; payload: Record<string, unknown> };
export type CloudCommandHandler = (command: CloudCommand, requestId: string) => Promise<unknown>;
export type CloudJobUpdate = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  jobId: string;
  deviceId: string;
  domainSessionId?: string;
  status: string;
  /** What the agent actually wrote, for the screen. */
  summary?: string;
  /** The sentence written to be read aloud, for the assistant. */
  spokenSummary?: string;
};

export type CloudSocket = {
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((error: unknown) => void) | null;
};

export type CloudTunnelOptions = {
  tunnelUrl: string;
  identity: DeviceIdentityStore;
  agentVersion?: string;
  platform?: string;
  /**
   * Which coding agents this machine has, asked once at connect time.
   *
   * Without it the assistant told a user it could not say whether Codex or Claude were installed,
   * and that the answer only arrives when a task starts. That was true of what the cloud had been
   * given and false of what this process knows: detection has already run by the time the socket
   * opens. Informational, like the two above — the cloud reads it against its own fixed list.
   */
  codingAgents?: () => Promise<readonly string[]>;
  handleCommand: CloudCommandHandler;
  log: (message: string, detail?: Record<string, unknown>) => void;
  createSocket: (url: string, headers: Record<string, string>) => CloudSocket;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
  loadPendingJobUpdates?: () => readonly CloudJobUpdate[];
  acknowledgeJobUpdate?: (eventId: string) => void;
  setTimeoutImplementation?: (handler: () => void, ms: number) => unknown;
};

/**
 * The daemon's side of the cloud tunnel.
 *
 * API Gateway offers no post-upgrade handshake: a WebSocket upgrade is one request, and either it is
 * authorized or there is no connection. So the proof travels in the headers of the upgrade itself —
 * a signature over the current time, made with the key this machine generated when it was paired.
 *
 * That the proof is single-use on the server is why a fresh timestamp is signed for every attempt
 * rather than one being cached and reused on reconnect.
 */
export class CloudTunnelClient {
  private socket: CloudSocket | null = null;
  private socketOpen = false;
  private stopping = false;
  private reconnectDelayMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly schedule: (handler: () => void, ms: number) => unknown;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly pendingJobUpdates = new Map<string, CloudJobUpdate>();

  constructor(private readonly options: CloudTunnelOptions) {
    this.initialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.maxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 240_000;
    this.reconnectDelayMs = this.initialDelayMs;
    this.schedule = options.setTimeoutImplementation ?? ((handler, ms) => setTimeout(handler, ms));
  }

  get isConnected(): boolean {
    return this.socketOpen;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.socketOpen = false;
    this.socket?.close();
    this.socket = null;
  }

  /** Tells the cloud a job moved on, so it can notify whoever is listening — or store it if nobody is. */
  reportJob(update: CloudJobUpdate): void {
    this.pendingJobUpdates.set(update.eventId, update);
    this.flushPendingJobUpdates();
  }

  /**
   * Fire and forget, because asking this machine which coding agents it has means running two
   * executables, and the signature below must be minted after that rather than before: the server
   * refuses a timestamp older than a minute, and a slow detection would age one signed first.
   *
   * Everything that follows already guards against a second connect overtaking the first, through
   * the `this.socket !== socket` checks in the handlers.
   */
  private connect(): void {
    void this.openSocket();
  }

  private async openSocket(): Promise<void> {
    const { identity, tunnelUrl, createSocket, log } = this.options;
    const deviceId = identity.deviceId;
    if (!deviceId) {
      log('not paired yet, so there is nothing to connect as');
      return;
    }

    // Failure here must never stop a machine connecting: a wrong list is a worse answer than none,
    // and no answer at all is worse than either. Asked before signing, never after.
    const coding = await this.options.codingAgents?.().catch(() => []);

    // Signed at the moment of connecting, never before: the server refuses a timestamp older than a
    // minute, and spends each signature once.
    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      'x-device-id': deviceId,
      'x-device-timestamp': timestamp,
      'x-device-signature': identity.sign(`${deviceId}:${timestamp}`),
    };
    // Optional for source-built/older callers. Informational only: the cloud never uses either
    // field for authorization; they let the owner see what needs updating.
    if (this.options.agentVersion) headers['x-agent-version'] = this.options.agentVersion;
    if (this.options.platform) headers['x-agent-platform'] = this.options.platform;
    if (coding && coding.length > 0) headers['x-agent-coding'] = coding.join(',');

    const socket = createSocket(tunnelUrl, headers);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.socketOpen = true;
      this.reconnectDelayMs = this.initialDelayMs;
      log('tunnel open');
      for (const update of this.options.loadPendingJobUpdates?.() ?? []) {
        if (!this.pendingJobUpdates.has(update.eventId)) {
          this.pendingJobUpdates.set(update.eventId, update);
        }
      }
      this.flushPendingJobUpdates();
      this.scheduleHeartbeat();
    };
    socket.onmessage = (event) => void this.receive(String(event.data));
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socketOpen = false;
      this.socket = null;
      log('tunnel closed', { code: event.code, reason: event.reason });
      this.scheduleReconnect();
    };
    socket.onerror = (error) => log('tunnel error', { error: String(error) });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = this.reconnectDelayMs;
    // A device whose signature is being rejected would otherwise hammer an authorizer that costs
    // money per invocation.
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxDelayMs);
    this.schedule(() => this.connect(), delay);
  }

  private scheduleHeartbeat(): void {
    this.schedule(() => {
      if (!this.socketOpen) return;
      // API Gateway drops a socket that has been idle for ten minutes; this keeps it, and doubles as
      // the signal that updates when the machine was last seen.
      this.send({ type: 'heartbeat', payload: {} });
      this.scheduleHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async receive(raw: string): Promise<void> {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === 'job_update_ack') {
      const eventId = typeof message.payload.eventId === 'string' ? message.payload.eventId : '';
      if (eventId) {
        this.pendingJobUpdates.delete(eventId);
        this.options.acknowledgeJobUpdate?.(eventId);
      }
      return;
    }
    if (message.type !== 'command_request') return;

    const requestId = String(message.payload.requestId ?? '');
    const command = message.payload.command as CloudCommand | undefined;
    if (!requestId || !command?.name) return;

    try {
      const existing = this.inFlight.get(requestId);
      const work =
        existing ??
        this.options.handleCommand(
          { name: command.name, payload: command.payload ?? {} },
          requestId,
        );
      if (!existing) this.inFlight.set(requestId, work);
      const result = await work;
      this.send({ type: 'command_result', payload: { requestId, result } });
    } catch (error) {
      // The cloud is waiting on this row; a command that throws must still answer, or the tool call
      // that asked for it sits there until it times out and tells the user nothing useful.
      //
      // The whole structured error travels, not `error.message`. A refusal the assistant is meant
      // to recover from carries the recovery with it — `PROVIDER_CHOICE_REQUIRED` carries the
      // sentence to say and the agents to offer in `details` — and flattening it to the technical
      // message left the model told that a choice was required with nothing to choose between.
      this.send({
        type: 'command_result',
        payload: { requestId, error: toStructuredError(error) },
      });
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  private send(message: { type: string; payload: Record<string, unknown> }): void {
    if (!this.socket || !this.socketOpen) return;
    this.socket.send(JSON.stringify(message));
  }

  private flushPendingJobUpdates(): void {
    if (!this.socketOpen) return;
    for (const update of this.pendingJobUpdates.values()) {
      this.send({ type: 'job_update', payload: update });
    }
  }
}

function parseMessage(raw: string): { type: string; payload: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as { type?: unknown; payload?: unknown };
    if (typeof candidate.type !== 'string') return null;
    return {
      type: candidate.type,
      payload:
        typeof candidate.payload === 'object' && candidate.payload !== null
          ? (candidate.payload as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}
