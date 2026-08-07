import WebSocket from 'ws';
import type { CloudSocket } from './cloud-tunnel-client.js';

/**
 * A real socket, wrapped in the small shape the tunnel client works against.
 *
 * The wrapper exists so the client can be tested without a network, and because the proof of
 * identity travels in the upgrade headers — something a browser WebSocket cannot do, and the reason
 * this only ever runs in the daemon.
 */
export function openCloudSocket(url: string, headers: Record<string, string>): CloudSocket {
  const socket = new WebSocket(url, { headers });

  const wrapper: CloudSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
  };

  socket.on('open', () => wrapper.onopen?.());
  socket.on('message', (data) => wrapper.onmessage?.({ data: data.toString() }));
  socket.on('close', (code, reason) => wrapper.onclose?.({ code, reason: reason.toString() }));
  socket.on('error', (error) => wrapper.onerror?.(error));

  return wrapper;
}
