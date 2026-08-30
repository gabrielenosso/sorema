import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExistingCodingSession } from '../provider-types.js';

/**
 * A compacted session opens with the whole summary written as one user turn, and the first thing a
 * person actually said comes after it. Sixty-four kilobytes stopped short of it here.
 */
const TRANSCRIPT_HEAD_BYTES = 512 * 1024;

/**
 * A transcript touched this recently has a client writing to it. The first thing this listing found
 * on the real machine was the session doing the finding, and resuming that would have put a second
 * writer on the same file. Codex reports the same fact outright, in a thread's `status`.
 */
const LIVE_WRITER_WINDOW_MS = 5 * 60 * 1000;
const TITLE_CHARACTER_LIMIT = 120;

export type ReadClaudeSessionsInput = {
  projectPath: string;
  homeDirectory: string;
  limit: number;
};

/**
 * The sessions Claude Code already holds for one project, newest first.
 *
 * Claude keeps a transcript per session under `~/.claude/projects/<encoded cwd>/<id>.jsonl`, where
 * the encoding replaces every separator and colon with a dash. That is not reversible — a folder
 * whose own name contains a dash lands on the same string — so the directory name is used for
 * nothing and the project is matched on the `cwd` each transcript records inside itself.
 *
 * Only the head of every file is read. A transcript here reaches twenty megabytes, and everything
 * this needs is written in the first few lines.
 */
export function readClaudeSessionsForProject(
  input: ReadClaudeSessionsInput,
): ExistingCodingSession[] {
  const projectsDirectory = join(input.homeDirectory, '.claude', 'projects');
  const wanted = comparablePath(input.projectPath);
  const found: (ExistingCodingSession & { modifiedAt: number })[] = [];

  for (const directory of directoriesIn(projectsDirectory)) {
    for (const name of filesIn(join(projectsDirectory, directory))) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projectsDirectory, directory, name);
      const head = readHead(path);
      if (head === null) continue;
      const transcript = summariseTranscript(head);
      if (transcript.cwd === null || comparablePath(transcript.cwd) !== wanted) continue;
      if (transcript.firstUserMessage === null) continue;
      const modifiedAt = modificationTime(path);
      if (Date.now() - modifiedAt < LIVE_WRITER_WINDOW_MS) continue;
      found.push({
        providerSessionId: name.slice(0, -'.jsonl'.length),
        title: transcript.firstUserMessage,
        lastActiveAt: new Date(modifiedAt).toISOString(),
        modifiedAt,
      });
    }
  }

  return found
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, input.limit)
    .map(({ modifiedAt: _modifiedAt, ...session }) => session);
}

/**
 * Every transcript for this project carries the same pinned title, so a list built from it reads as
 * one session repeated. What the person actually asked for is what tells them apart, and the first
 * user message is where the meta rows the client writes for itself have not reached yet.
 */
function summariseTranscript(head: string): {
  cwd: string | null;
  firstUserMessage: string | null;
} {
  let cwd: string | null = null;
  let firstUserMessage: string | null = null;
  for (const line of head.split('\n')) {
    const row = parseRow(line);
    if (row === null) continue;
    if (cwd === null && typeof row.cwd === 'string' && row.cwd) cwd = row.cwd;
    if (firstUserMessage === null && isSomethingThePersonSaid(row)) {
      firstUserMessage = readableUserText(row.message);
    }
    if (cwd !== null && firstUserMessage !== null) break;
  }
  return { cwd, firstUserMessage };
}

/**
 * Claude writes several kinds of row as user turns that no person typed: the summary carried across
 * a compaction, the note left where a turn was interrupted, and the instructions a subagent is
 * given. None of them is what this session was about.
 */
function isSomethingThePersonSaid(row: Record<string, unknown>): boolean {
  return (
    row.type === 'user' &&
    row.isSidechain !== true &&
    row.isCompactSummary !== true &&
    row.isMeta !== true &&
    row.isVisibleInTranscriptOnly !== true
  );
}

function readableUserText(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return spokenTitle(content);
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    const text = (part as { type?: unknown; text?: unknown }).text;
    if ((part as { type?: unknown }).type === 'text' && typeof text === 'string') {
      const title = spokenTitle(text);
      if (title !== null) return title;
    }
  }
  return null;
}

/** The client writes its own instructions into the transcript as user turns; those are not a title. */
function spokenTitle(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed || collapsed.startsWith('<') || collapsed.startsWith('[Request interrupted')) {
    return null;
  }
  if (collapsed.length <= TITLE_CHARACTER_LIMIT) return collapsed;
  return `${collapsed.slice(0, TITLE_CHARACTER_LIMIT - 1).trimEnd()}…`;
}

function parseRow(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readHead(path: string): string | null {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(handle);
  }
}

function directoriesIn(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function filesIn(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function modificationTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Windows writes the same folder as `C:\x` and `c:/x/`, and both have to reach the same project. */
function comparablePath(path: string): string {
  return resolve(path)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}
