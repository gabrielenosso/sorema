import type { ExistingCodingSession } from '../provider-types.js';

const TITLE_CHARACTER_LIMIT = 120;

/**
 * What `thread/list` calls a thread, reduced to the three things worth saying out loud.
 *
 * The shape is the app-server's own `Thread`, and only the fields read here are declared: the
 * protocol is experimental and grows a field a release, and matching it in full would mean a
 * breaking change every time OpenAI adds one.
 */
export type CodexThread = {
  id?: unknown;
  cwd?: unknown;
  preview?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  status?: unknown;
};

export function threadsToExistingSessions(
  threads: readonly CodexThread[],
): ExistingCodingSession[] {
  const sessions: ExistingCodingSession[] = [];
  for (const thread of threads) {
    const providerSessionId = typeof thread.id === 'string' ? thread.id : '';
    const title = singleLine(typeof thread.preview === 'string' ? thread.preview : '');
    const projectPath = typeof thread.cwd === 'string' ? thread.cwd : '';
    if (!providerSessionId || !title || !projectPath) continue;
    if (isStillLoaded(thread.status)) continue;
    sessions.push({
      providerSessionId,
      projectPath,
      title,
      lastActiveAt: toTimestamp(thread.updatedAt ?? thread.recencyAt),
    });
  }
  return sessions;
}

/**
 * A thread the desktop application still has open has a writer on it already. Resuming it from here
 * would put a second one on the same transcript, so it is left out of the list rather than offered
 * and then refused.
 */
function isStillLoaded(status: unknown): boolean {
  if (status === null || typeof status !== 'object') return false;
  const type = (status as { type?: unknown }).type;
  return typeof type === 'string' && type !== 'notLoaded';
}

function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_CHARACTER_LIMIT) return collapsed;
  return `${collapsed.slice(0, TITLE_CHARACTER_LIMIT - 1).trimEnd()}…`;
}

function toTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return new Date(0).toISOString();
  return new Date(value * 1000).toISOString();
}
