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
    if (titleTokens.has(token)) score += 4;
    if (keywordTokens.has(token)) score += 3;
    if (summaryTokens.has(token)) score += 1.5;
    if (entryTokens.has(token)) score += 1;
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
