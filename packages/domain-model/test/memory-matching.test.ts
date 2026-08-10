import { describe, expect, it } from 'vitest';
import { rankThreadsAgainstQuery, type MemoryThread, type ThreadMatchInput } from '../src/index.js';

/**
 * The prefix rule, at the level the fixture corpus cannot reach.
 *
 * `infrastructure/test/memory-retrieval.test.ts` says what the rule is worth over realistic
 * questions; it says nothing about where the rule stops, because a corpus of five subjects has no
 * near-collisions in it. The floor and the ordering are asserted here against pairs chosen to sit
 * either side of both.
 */
const NOW = Date.parse('2026-08-10T09:00:00.000Z');
const DAY = 86_400_000;

function threadRecordedDaysAgo(
  title: string,
  entryText: string,
  daysAgo: number,
): ThreadMatchInput {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  const thread: MemoryThread = {
    id: title,
    userId: 'user-1',
    title,
    summary: entryText,
    keywords: [],
    status: 'active',
    createdAt: at,
    updatedAt: at,
    lastDiscussedAt: at,
  };
  return { thread, entryTexts: [entryText] };
}

function titlesFor(query: string, threads: readonly ThreadMatchInput[]): string[] {
  return rankThreadsAgainstQuery(threads, query, { now: NOW }).map((match) => match.thread.title);
}

describe('matching a spoken word against the word that was stored', () => {
  it('reaches a subject the speaker abbreviated', () => {
    const threads = [
      threadRecordedDaysAgo('back pain', 'Started physiotherapy at the clinic.', 60),
    ];

    expect(titlesFor('the physio is going badly', threads)).toEqual(['back pain']);
  });

  it.each([
    ['sessions', 'The second session hurt more than the first.'],
    ['session', 'Two sessions a week for six weeks.'],
    ['workouts', 'The workout was harder than last time.'],
    ['workout', 'Morning workouts three times a week.'],
  ])('reads %s and what was stored as the same word', (spoken, stored) => {
    const threads = [threadRecordedDaysAgo('back pain', stored, 30)];

    expect(titlesFor(spoken, threads)).toEqual(['back pain']);
  });

  /**
   * The pairs that motivate the floor at all. Both share a prefix, both are plainly different
   * subjects, and a floor of three or four admits them.
   */
  it.each([
    ['gymnastics', 'Watched the gym class on Saturday.'],
    ['taxi', 'The tax return is due in September.'],
    ['work', 'The workouts are getting easier.'],
  ])('does not let %s reach an unrelated subject that starts the same way', (spoken, stored) => {
    const threads = [threadRecordedDaysAgo('something else', stored, 30)];

    expect(titlesFor(spoken, threads)).toEqual([]);
  });

  /**
   * The claim the fixture cannot make, because no two of its threads answer one question. A thread
   * that matched the whole word must not be displaced by one that matched half of it, and recency is
   * what would do the displacing: the half-matching thread here is two months newer and matches on
   * the same fields, so only the weight on a prefix match keeps the older, exact thread on top.
   */
  it('ranks the thread that matched the whole word above the one that matched half of it', () => {
    const threads = [
      threadRecordedDaysAgo('back pain', 'Started physiotherapy at the clinic.', 60),
      threadRecordedDaysAgo('insurance', 'The physio claim was rejected.', 0),
    ];

    expect(titlesFor('physiotherapy', threads)).toEqual(['back pain', 'insurance']);
  });
});
