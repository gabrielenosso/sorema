import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeSessionsForProject } from '../src/domains/coding/providers/claude-session-store.js';
import { threadsToExistingSessions } from '../src/domains/coding/providers/codex-thread-listing.js';

/**
 * Work already started in the Codex or Claude desktop application is invisible to Sorema: the
 * person asks to carry on with what they were doing this morning, and the assistant can only offer
 * to start again from nothing. Both agents keep their own transcript store, and both can be asked
 * to resume one, so the missing piece was only ever a way to read the list.
 */
/**
 * A transcript is only offered once nothing has written to it for a while, so a fixture written
 * this instant looks exactly like a session that is open right now. Every one that stands for
 * finished work is dated an hour ago.
 */
function writeFinishedTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n'));
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(path, anHourAgo, anHourAgo);
}

const WINDOWS_PROJECT = 'C:\\Users\\me\\CODE\\sorema';

describe('sessions the desktop applications already have', () => {
  describe('codex, from what the app-server reports', () => {
    const thread = (over: Record<string, unknown>) => ({
      id: '019ff153-a463-75b1-a8ad-275be673ad46',
      cwd: 'C:\\Users\\me\\CODE\\sorema',
      preview: 'RIESCI A CAPIRE COS\u2019\u00e8 questo progetto?\nc\u2019\u00e8 documentazione?',
      updatedAt: 1788123924,
      source: 'vscode',
      status: { type: 'notLoaded' },
      ...over,
    });

    it('reads the first message as the title, on one line', () => {
      const [session] = threadsToExistingSessions([thread({})]);
      expect(session?.title).toBe(
        'RIESCI A CAPIRE COS\u2019\u00e8 questo progetto? c\u2019\u00e8 documentazione?',
      );
      expect(session?.providerSessionId).toBe('019ff153-a463-75b1-a8ad-275be673ad46');
    });

    it('reports when the session was last touched, as a timestamp and not a unix second', () => {
      const [session] = threadsToExistingSessions([thread({})]);
      expect(session?.lastActiveAt).toBe(new Date(1788123924 * 1000).toISOString());
    });

    /**
     * A thread the desktop application currently has open has a live writer. Resuming it from here
     * would put a second one on the same transcript, so it is not offered.
     */
    it('leaves out a thread the application still has loaded', () => {
      expect(threadsToExistingSessions([thread({ status: { type: 'running' } })])).toEqual([]);
    });

    it('leaves out a thread with nothing to show for it', () => {
      expect(threadsToExistingSessions([thread({ preview: '   ' })])).toEqual([]);
    });
  });

  describe('claude, from its own transcript directory', () => {
    function projectsDirectory(): string {
      const home = mkdtempSync(join(tmpdir(), 'sorema-claude-'));
      return home;
    }

    function transcript(home: string, directory: string, name: string, lines: object[]): void {
      mkdirSync(join(home, '.claude', 'projects', directory), { recursive: true });
      writeFinishedTranscript(
        join(home, '.claude', 'projects', directory, name),
        lines.map((line) => JSON.stringify(line)),
      );
    }

    /**
     * The directory name encodes the project path by replacing every separator and colon with a
     * dash, which cannot be turned back into a path. The `cwd` written inside each transcript can,
     * so that is what the project is matched on.
     */
    it('matches on the path recorded inside the transcript, not on the directory name', () => {
      const home = projectsDirectory();
      transcript(home, 'C--Users-me-CODE-sorema', 'aaaa.jsonl', [
        { type: 'custom-title', customTitle: 'SOREMA' },
        { type: 'user', cwd: WINDOWS_PROJECT, message: { content: 'fix the deploy' } },
      ]);
      transcript(home, 'C--Users-me-CODE-sorema-cloud', 'bbbb.jsonl', [
        { type: 'user', cwd: WINDOWS_PROJECT + '-cloud', message: { content: 'the other one' } },
      ]);

      const sessions = readClaudeSessionsForProject({
        projectPath: WINDOWS_PROJECT,
        homeDirectory: home,
        limit: 10,
      });

      expect(sessions.map((session) => session.providerSessionId)).toEqual(['aaaa']);
    });

    /**
     * Every transcript for this project carries the same pinned title, so a list built from it
     * reads as one session repeated. What the person actually asked for is what tells them apart.
     */
    it('titles a session by what was asked, not by the name pinned on the project', () => {
      const home = projectsDirectory();
      transcript(home, 'anything', 'cccc.jsonl', [
        { type: 'custom-title', customTitle: 'SOREMA' },
        {
          type: 'user',
          cwd: WINDOWS_PROJECT,
          message: { content: [{ type: 'text', text: 'rewrite the privacy notice' }] },
        },
      ]);

      const [session] = readClaudeSessionsForProject({
        projectPath: WINDOWS_PROJECT,
        homeDirectory: home,
        limit: 10,
      });

      expect(session?.title).toBe('rewrite the privacy notice');
    });

    /**
     * Every long session here is a compacted one, and the row Claude writes to carry the summary
     * across is a user turn like any other. Reading it as the title made the live list come back as
     * six copies of "This session is being continued from a previous conversation".
     */
    it('skips the summary claude writes to itself when a session is compacted', () => {
      const home = projectsDirectory();
      transcript(home, 'anything', 'dddd.jsonl', [
        {
          type: 'user',
          cwd: WINDOWS_PROJECT,
          isCompactSummary: true,
          message: { content: 'This session is being continued from a previous conversation.' },
        },
        { type: 'user', message: { content: '[Request interrupted by user]' } },
        { type: 'user', message: { content: 'move the fonts folder' } },
      ]);

      const [session] = readClaudeSessionsForProject({
        projectPath: WINDOWS_PROJECT,
        homeDirectory: home,
        limit: 10,
      });

      expect(session?.title).toBe('move the fonts folder');
    });

    /**
     * A transcript being written to right now has a live client on it, and the first thing this
     * listing found on the real machine was the session doing the finding. Resuming it would put a
     * second writer on the same file.
     */
    it('leaves out a session that is being written to right now', () => {
      const home = projectsDirectory();
      const directory = join(home, '.claude', 'projects', 'anything');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'eeee.jsonl'),
        JSON.stringify({ type: 'user', cwd: WINDOWS_PROJECT, message: { content: 'happening' } }),
      );

      expect(
        readClaudeSessionsForProject({
          projectPath: WINDOWS_PROJECT,
          homeDirectory: home,
          limit: 10,
        }),
      ).toEqual([]);
    });

    it('answers with an empty list when the person has never used claude', () => {
      const home = projectsDirectory();
      expect(
        readClaudeSessionsForProject({
          projectPath: WINDOWS_PROJECT,
          homeDirectory: home,
          limit: 10,
        }),
      ).toEqual([]);
    });
  });
});
