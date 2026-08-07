import type { DeviceIdentityStore } from '../identity/device-identity-store.js';

export type CloudCommand = { name: string; payload: Record<string, unknown> };
export type CloudCommandHandler = (command: CloudCommand) => Promise<unknown>;

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
  handleCommand: CloudCommandHandler;
  log: (message: string, detail?: Record<string, unknown>) => void;
  createSocket: (url: string, headers: Record<string, string>) => CloudSocket;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
  setTimeoutImplementation?: (handler: () => void, ms: number) => unknown;
};

/**
 * The daemon's side of the cloud tunnel.
 *
 * The old gateway authenticated with a challenge it sent after the socket opened. API Gateway offers
 * no such round trip: a WebSocket upgrade is one request, and either it is authorized or there is no
 * connection. So the proof travels in the headers of the upgrade itself — a signature over the
 * current time, made with the key this machine generated when it was paired.
 *
 * That the proof is single-use on the server is why a fresh timestamp is signed for every attempt
 * rather than one being cached and reused on reconnect.
 */
export class CloudTunnelClient {
  private socket: CloudSocket | null = null;
  private stopping = false;
  private reconnectDelayMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly schedule: (handler: () => void, ms: number) => unknown;

  constructor(private readonly options: CloudTunnelOptions) {
    this.initialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.maxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 240_000;
    this.reconnectDelayMs = this.initialDelayMs;
    this.schedule = options.setTimeoutImplementation ?? ((handler, ms) => setTimeout(handler, ms));
  }

  get isConnected(): boolean {
    return this.socket !== null;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
    this.socket = null;
  }

  /** Tells the cloud a job moved on, so it can notify whoever is listening — or store it if nobody is. */
  reportJob(update: { jobId: string; status: string; summary?: string }): void {
    this.send({ type: 'job_update', payload: update });
  }

  private connect(): void {
    const { identity, tunnelUrl, createSocket, log } = this.options;
    const deviceId = identity.deviceId;
    if (!deviceId) {
      log('not paired yet, so there is nothing to connect as');
      return;
    }

    // Signed at the moment of connecting, never before: the server refuses a timestamp older than a
    // minute, and spends each signature once.
    const timestamp = new Date().toISOString();
    const headers = {
      'x-device-id': deviceId,
      'x-device-timestamp': timestamp,
      'x-device-signature': identity.sign(`${deviceId}:${timestamp}`),
    };

    const socket = createSocket(tunnelUrl, headers);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelayMs = this.initialDelayMs;
      log('tunnel open');
      this.scheduleHeartbeat();
    };
    socket.onmessage = (event) => void this.receive(String(event.data));
    socket.onclose = (event) => {
      this.socket = null;
      log('tunnel closed', { code: event.code, reason: event.reason });
      this.scheduleReconnect();
    };
    socket.onerror = (error) => log('tunnel error', { error: String(error) });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = this.reconnectDelayMs;
    // Backing off matters more here than it did against our own gateway: a device whose signature is
    // being rejected would otherwise hammer an authorizer that costs money per invocation.
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxDelayMs);
    this.schedule(() => this.connect(), delay);
  }

  private scheduleHeartbeat(): void {
    this.schedule(() => {
      if (!this.socket) return;
      // API Gateway drops a socket that has been idle for ten minutes; this keeps it, and doubles as
      // the signal that updates when the machine was last seen.
      this.send({ type: 'heartbeat', payload: {} });
      this.scheduleHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async receive(raw: string): Promise<void> {
    const message = parseMessage(raw);
    if (!message || message.type !== 'command_request') return;

    const requestId = String(message.payload.requestId ?? '');
    const command = message.payload.command as CloudCommand | undefined;
    if (!requestId || !command?.name) return;

    try {
      const result = await this.options.handleCommand({
        name: command.name,
        payload: command.payload ?? {},
      });
      this.send({ type: 'command_result', payload: { requestId, result } });
    } catch (error) {
      // The cloud is waiting on this row; a command that throws must still answer, or the tool call
      // that asked for it sits there until it times out and tells the user nothing useful.
      this.send({
        type: 'command_result',
        payload: { requestId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private send(message: { type: string; payload: Record<string, unknown> }): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(message));
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
