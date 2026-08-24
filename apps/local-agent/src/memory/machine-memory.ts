import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The notes, kept on the machine the person owns rather than in the hosted service.
 *
 * This is the whole of the `tool` memory mode. What somebody asks Sorema to remember is a subject
 * they chose, which is the one thing in this product that can be health, belief, or anything else
 * Article 9 protects. Keeping it here means the operator stores none of it, and the question stops
 * being how well a filter guesses.
 *
 * One markdown file, and both halves of that matter. Markdown is what the coding agents already
 * installed on this machine read, so these notes can be handed to them without conversion. One file
 * is what lets the owner open it, read every word, correct a line and delete a paragraph with a text
 * editor — rights that in the cloud need a screen each, answered here by the filesystem.
 *
 * Nothing is cached. The file on disk is the truth at the moment of the question, so an edit made by
 * hand between two sentences is honoured rather than overwritten.
 */
export type RecalledThread = {
  title: string;
  recentEntries: { text: string; occurredAt: string }[];
};

const FILE_NAME = 'memory.md';
const MAX_ENTRIES_READ_BACK = 20;

type Thread = { title: string; entries: { text: string; occurredAt: string }[] };

export class MachineMemory {
  private readonly filePath: string;

  constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.filePath = join(stateDirectory, FILE_NAME);
  }

  /** Where the notes are, so the daemon can tell somebody who wants to read or delete them. */
  get path(): string {
    return this.filePath;
  }

  async remember(subject: string, text: string): Promise<{ title: string; created: boolean }> {
    const threads = this.read();
    const title = subject.trim();
    const existing = threads.find((thread) => sameSubject(thread.title, title));
    const occurredAt = new Date().toISOString();

    if (existing) {
      existing.entries.push({ text: text.trim(), occurredAt });
    } else {
      threads.push({ title, entries: [{ text: text.trim(), occurredAt }] });
    }

    this.write(threads);
    return { title: existing?.title ?? title, created: existing === undefined };
  }

  async recall(query: string): Promise<{ threads: RecalledThread[]; spokenSummary: string }> {
    const wanted = wordsIn(query);
    const matched = this.read().filter((thread) => {
      const haystack = wordsIn([thread.title, ...thread.entries.map((e) => e.text)].join(' '));
      return [...wanted].some((word) => haystack.has(word));
    });

    if (matched.length === 0) {
      return { threads: [], spokenSummary: `Nothing written down about ${query}.` };
    }

    return {
      threads: matched.map((thread) => ({
        title: thread.title,
        recentEntries: thread.entries.slice(-MAX_ENTRIES_READ_BACK),
      })),
      spokenSummary: matched
        .map(
          (thread) =>
            `${thread.title}, ${thread.entries.length === 1 ? '1 note' : `${thread.entries.length} notes`}`,
        )
        .join('; '),
    };
  }

  /**
   * Parsed rather than kept, because the file is the record and this process is only one of the
   * things that writes to it. A heading opens a subject; a `- ` line is a note under it; anything
   * else is somebody's own prose and is left where it is by being read as a note too, which is the
   * forgiving reading rather than the one that silently drops what a person typed.
   */
  private read(): Thread[] {
    if (!existsSync(this.filePath)) return [];
    const threads: Thread[] = [];
    for (const line of readFileSync(this.filePath, 'utf8').split(/\r?\n/)) {
      const heading = /^##\s+(.*\S)\s*$/.exec(line);
      if (heading) {
        threads.push({ title: heading[1] as string, entries: [] });
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === '' || threads.length === 0) continue;
      const entry = /^-\s+(.*)$/.exec(trimmed);
      const text = (entry?.[1] ?? trimmed).trim();
      if (text !== '') {
        (threads[threads.length - 1] as Thread).entries.push({ text, occurredAt: '' });
      }
    }
    return threads;
  }

  private write(threads: Thread[]): void {
    const body = threads
      .map(
        (thread) =>
          `## ${thread.title}\n\n${thread.entries.map((entry) => `- ${entry.text}`).join('\n')}\n`,
      )
      .join('\n');
    writeFileSync(
      this.filePath,
      `<!-- Sorema keeps your notes here. Edit or delete anything; it is read fresh every time. -->\n\n${body}`,
      'utf8',
    );
  }
}

function wordsIn(value: string): Set<string> {
  return new Set(
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function sameSubject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
