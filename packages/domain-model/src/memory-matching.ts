import type { MemoryThread } from './memory.js';

/**
 * Words carrying no topical signal. Kept deliberately small and multilingual rather than exhaustive:
 * over-filtering loses real subjects ("il mio male" would lose "male"), and the scoring already
 * discounts common words by only rewarding matches.
 */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'my',
  'me',
  'i',
  'is',
  'it',
  'to',
  'and',
  'about',
  'lets',
  'let',
  'talk',
  'we',
  'you',
  'our',
  'that',
  'this',
  'for',
  'with',
  'on',
  'in',
  'at',
  'was',
  'were',
  // Missing for as long as its three siblings above have been here, and invisible for as long as the
  // retrieval fixture held five threads, none of which happened to contain the word. On a corpus the
  // size of a real account it is in a dozen notes, it is stored as a keyword by `keywordsFor`, and it
  // carried "how are my workouts going" to a conference talk and a holiday.
  'are',
  'be',
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'di',
  'del',
  'della',
  'dei',
  'delle',
  'mio',
  'mia',
  'miei',
  'mie',
  'parliamo',
  'parlare',
  'che',
  'come',
  'per',
  'con',
  'su',
  'e',
  'ho',
  'sono',
  'ha',
  'hai',
  'del',
  'al',
  'da',
  'dal',
  'ne',
  'ci',
  'si',
  'mi',
  'te',
  'ti',
]);

export function tokenizeForMatching(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * How much of a word two tokens have to share before they are treated as the same subject.
 *
 * "physio" is how people say "physiotherapy" out loud, and "workouts" is the same subject as
 * "workout", so exact equality loses both. Below five characters this stops being a synonym and
 * becomes an accident: "gym" reaches "gymnastics" and "tax" reaches "taxi" at three, and "work"
 * reaches "workouts" at four though one is a job and the other is exercise.
 *
 * The retrieval fixture scores *higher* at four, and that is the reason to distrust it rather than
 * to lower this: the extra recall there is entirely "workouts" finding the gym thread through the
 * word "work" in "three mornings a week before work". Seven and above lose "physio", which is six.
 */
const MINIMUM_SHARED_PREFIX_LENGTH = 5;

/**
 * A prefix match is weaker evidence than the whole word, so it earns a fraction of whatever the field
 * was already worth rather than a weight of its own. Keeping it proportional is what makes the
 * ordering hold everywhere: a thread that matched "physiotherapy" outscores one that matched only
 * "physio" on the same field, and the coverage term below — which divides by the exact-match maximum
 * — pushes the half-matched thread further down again rather than letting recency close the gap.
 */
const PREFIX_MATCH_WEIGHT = 0.6;

function sharesPrefix(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= MINIMUM_SHARED_PREFIX_LENGTH && longer.startsWith(shorter);
}

function matchStrength(queryToken: string, storedTokens: ReadonlySet<string>): number {
  if (storedTokens.has(queryToken)) return 1;
  for (const storedToken of storedTokens) {
    if (sharesPrefix(queryToken, storedToken)) return PREFIX_MATCH_WEIGHT;
  }
  return 0;
}

const RECENCY_HALF_LIFE_DAYS = 30;

export function computeRecencyBoost(lastDiscussedAt: string, now: number = Date.now()): number {
  const ageMs = Math.max(0, now - Date.parse(lastDiscussedAt));
  const ageDays = ageMs / 86_400_000;
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

export type ThreadMatchInput = {
  thread: MemoryThread;
  entryTexts: readonly string[];
};

/**
 * Scores how well a thread answers a spoken query. Plain token overlap with weights, not embeddings:
 * a personal assistant has tens or hundreds of threads, not millions, so ranking in code is both
 * accurate enough and portable to any store we move to later.
 */
export function scoreThreadAgainstQuery(
  input: ThreadMatchInput,
  queryTokens: readonly string[],
  now: number = Date.now(),
): number {
  if (queryTokens.length === 0) return 0;

  const titleTokens = new Set(tokenizeForMatching(input.thread.title));
  const keywordTokens = new Set(input.thread.keywords.flatMap(tokenizeForMatching));
  const summaryTokens = new Set(tokenizeForMatching(input.thread.summary));
  const entryTokens = new Set(input.entryTexts.flatMap(tokenizeForMatching));

  let score = 0;
  for (const token of new Set(queryTokens)) {
    score += 4 * matchStrength(token, titleTokens);
    score += 3 * matchStrength(token, keywordTokens);
    score += 1.5 * matchStrength(token, summaryTokens);
    score += 1 * matchStrength(token, entryTokens);
  }

  if (score === 0) return 0;

  const coverage = score / (queryTokens.length * 4);
  return (
    score * (1 + 0.5 * computeRecencyBoost(input.thread.lastDiscussedAt, now)) * (0.5 + coverage)
  );
}

export function rankThreadsAgainstQuery(
  threads: readonly ThreadMatchInput[],
  query: string,
  options: { limit?: number; now?: number } = {},
): { thread: MemoryThread; score: number }[] {
  const queryTokens = tokenizeForMatching(query);
  return threads
    .map((candidate) => ({
      thread: candidate.thread,
      score: scoreThreadAgainstQuery(candidate, queryTokens, options.now),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 3);
}
