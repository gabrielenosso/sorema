import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  resolveExecutablePath,
  spawnResolvedExecutable,
} from '../../../process/executable-resolver.js';
import type { CodexThread } from './codex-thread-listing.js';

const REQUEST_TIMEOUT_MS = 10_000;

export type CodexAppServerOptions = {
  executablePath: string;
  executableArguments?: readonly string[];
};

/**
 * One question put to `codex app-server`, which speaks newline-delimited JSON-RPC over stdio.
 *
 * The alternative was to read `~/.codex/sessions` directly. Codex writes one rollout file per run
 * and this machine has more than three thousand of them, so answering "what was I working on" would
 * have meant opening every file to find the handful with the right `cwd` — a scan whose cost grows
 * with everything the person has ever run. The app-server keeps an index and answers from it in a
 * few milliseconds, and `useStateDbOnly` is what says so: without it the same call repairs thread
 * metadata by walking those rollouts, and took more than thirty seconds here.
 *
 * The process is started for the question and ends with it. A long-lived one would have to be
 * supervised, restarted, and kept from holding the state database open while the desktop
 * application writes to it, and the handshake costs under two hundred milliseconds.
 */
export async function listCodexThreads(
  options: CodexAppServerOptions,
  parameters: { cwd: string; limit: number },
): Promise<CodexThread[]> {
  const resolvedExecutable = resolveExecutablePath(options.executablePath);
  if (!resolvedExecutable) return [];

  const child = spawnResolvedExecutable(
    resolvedExecutable,
    [...(options.executableArguments ?? []), 'app-server'],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'error' },
    },
  ) as ChildProcessWithoutNullStreams;

  child.stdin.on('error', () => undefined);

  try {
    const connection = openConnection(child);
    await connection.request('initialize', {
      clientInfo: { name: 'sorema', title: 'Sorema', version: '1' },
      capabilities: null,
    });
    connection.notify('initialized');
    const result = await connection.request('thread/list', {
      cwd: parameters.cwd,
      limit: parameters.limit,
      useStateDbOnly: true,
    });
    return readThreads(result);
  } finally {
    child.kill();
  }
}

/**
 * The response carries the page under `data`; `threads` was the obvious guess and is not the field,
 * which is why this reads the one the server actually sends and treats anything else as no answer.
 */
function readThreads(result: unknown): CodexThread[] {
  if (result === null || typeof result !== 'object') return [];
  const data = (result as { data?: unknown }).data;
  return Array.isArray(data) ? (data as CodexThread[]) : [];
}

type Connection = {
  request: (method: string, parameters: unknown) => Promise<unknown>;
  notify: (method: string) => void;
};

function openConnection(child: ChildProcessWithoutNullStreams): Connection {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextRequestId = 1;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line) deliver(line);
    }
  });

  const failEverything = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', failEverything);
  child.on('exit', () => failEverything(new Error('codex app-server exited')));

  function deliver(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      waiter.reject(new Error(describeRemoteError(message.error)));
      return;
    }
    waiter.resolve(message.result);
  }

  return {
    request(method, parameters) {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server did not answer ${method}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params: parameters })}\n`,
        );
      });
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

function describeRemoteError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'codex app-server refused the request';
}
