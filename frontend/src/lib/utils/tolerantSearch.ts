/**
 * The ecosystem's search contract, applied in the browser (`docs/wiki/search-contract.md`).
 *
 * Canari's other search boxes ask the server, which applies the contract in Postgres
 * (`apps/core-service/src/users/userSearch.ts`). A box searching data the client already holds - the
 * emoji picker's catalogue was the first - applies the SAME contract here rather than inventing a
 * fifth ladder:
 *
 * - case and accents folded first (`foldForSearch`);
 * - a query is a CONJUNCTION: every typed word must match some word of the candidate;
 * - word order is irrelevant, because words are matched to words;
 * - tiers, closest first: an exact word, a prefix, a substring, then a typo - and only the typo tier
 *   is charged an edit, because somebody who typed "dupon" stopped typing rather than erred;
 * - the typo tier is OSA distance, its tolerance taken from the SHORTER of the two words: 0 up to 3
 *   characters, 1 from 4 to 7, 2 from 8.
 */
import { foldForSearch } from './textFold';

/** How close one query word came to one candidate word; lower is closer. */
export const MatchTier = { EXACT: 0, PREFIX: 1, SUBSTRING: 2, TYPO: 3 } as const;
export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/**
 * Lower-cased, accent-free words of `text`, split on anything that is not a letter or digit.
 *
 * The ligatures are spelled out HERE, not in `foldForSearch`: French writes "cœur" and a person types
 * "coeur", and `foldForSearch` must keep one character per character because `foldWithIndex` maps
 * positions back for highlighting.
 */
export function searchTokens(text: string): string[] {
  return foldForSearch(text)
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The edit budget for a pair of words, from the shorter one (see the header). */
export function editTolerance(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter <= 3) return 0;
  if (shorter <= 7) return 1;
  return 2;
}

/**
 * Optimal string alignment distance: Levenshtein, with a swap of two adjacent characters charged as
 * ONE edit. Stops early and returns `limit + 1` once no alignment can stay within `limit`.
 */
export function osaDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  }
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > limit) return limit + 1;
  }
  return rows[a.length][b.length];
}

/** The best tier at which `query` matches any of `words`, or `null` when it matches none. */
export function bestTier(query: string, words: readonly string[]): MatchTier | null {
  let best: MatchTier | null = null;
  for (const word of words) {
    let tier: MatchTier | null = null;
    if (word === query) tier = MatchTier.EXACT;
    else if (word.startsWith(query)) tier = MatchTier.PREFIX;
    else if (word.includes(query)) tier = MatchTier.SUBSTRING;
    else {
      const limit = editTolerance(query, word);
      if (limit > 0 && osaDistance(query, word, limit) <= limit) tier = MatchTier.TYPO;
    }
    if (tier === MatchTier.EXACT) return tier;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/**
 * Ranks `items` against `query`: every query word must match (a conjunction), and an item's score is
 * the sum of its words' tiers, so closer matches come first. Ties keep the input order, which is the
 * caller's meaningful order (the emoji catalogue's own). An empty query returns nothing.
 */
export function rankByTokens<T>(
  items: readonly T[],
  query: string,
  wordsOf: (item: T) => readonly string[]
): T[] {
  const queryWords = searchTokens(query);
  if (queryWords.length === 0) return [];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const words = wordsOf(item);
    let score = 0;
    for (const q of queryWords) {
      const tier = bestTier(q, words);
      if (tier === null) return;
      score += tier;
    }
    scored.push({ item, score, index });
  });
  scored.sort((x, y) => x.score - y.score || x.index - y.index);
  return scored.map((s) => s.item);
}
