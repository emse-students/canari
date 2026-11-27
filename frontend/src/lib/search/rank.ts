/**
 * RANKING A LIST THE DEVICE HOLDS AGAINST WHAT WAS TYPED - the one implementation behind every
 * section of the universal search that is matched on the device (Discussions' names, Communities,
 * Associations, Events, Forms, Settings), so two sections never disagree about what "matches" means.
 *
 * It keeps the ecosystem's search contract (`docs/wiki/search-contract.md`): case and accents folded
 * (`foldForSearch`), word order irrelevant, EVERY typed word must match something, and the answers
 * RANKED rather than filtered. The tiers, best first:
 *
 *  0. the whole label is the query;
 *  1. the label starts with the query;
 *  2. every typed word starts a word of the label;
 *  3. every typed word is somewhere inside the label;
 *  4. every typed word is within the contract's typo tolerance of a word of the label (OSA distance,
 *     tolerance from the SHORTER token: 0 up to 3 characters, 1 from 4 to 7, 2 from 8). The ladder
 *     itself is `utils/tolerantSearch.ts`'s, the one browser copy of the contract; this module adds
 *     the whole-label tiers a list of NAMES needs, which the emoji catalogue's word sum does not.
 *
 * Inside a tier the caller's own order is kept (a stable sort), because that order already means
 * something the caller can explain - recency for conversations, the start date for events - and
 * charter principle 3 asks that every ranking explain itself in one sentence: "best match first,
 * then the most recent".
 */
import { foldForSearch } from '$lib/utils/textFold';
import { editTolerance, osaDistance } from '$lib/utils/tolerantSearch';

/** A query folded once and split into its words; empty words are dropped. */
export interface FoldedQuery {
  /** The whole query, folded and with its spaces collapsed. */
  whole: string;
  /** Its words, folded. Empty when nothing searchable was typed. */
  tokens: string[];
}

/** Folds `query` and splits it into words, once, so N labels do not fold it N times. */
export function foldQuery(query: string): FoldedQuery {
  const whole = foldForSearch(query).replace(/\s+/g, ' ').trim();
  return { whole, tokens: whole ? whole.split(' ') : [] };
}

/** The words of a folded label: split on anything that is not a letter or a digit. */
function wordsOf(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Whether `token` is within the contract's tolerance of one of `words`. */
function nearAWord(token: string, words: readonly string[]): boolean {
  return words.some((w) => {
    const tol = editTolerance(token, w);
    return tol > 0 && osaDistance(token, w, tol) <= tol;
  });
}

/**
 * The tier `label` reaches for `query` (0 best, 4 worst), or `null` when it does not match at all.
 * An empty query matches nothing: the search never lists a whole section unasked.
 */
export function matchTier(label: string, query: FoldedQuery): number | null {
  if (query.tokens.length === 0) return null;
  const folded = foldForSearch(label).replace(/\s+/g, ' ').trim();
  if (!folded) return null;
  if (folded === query.whole) return 0;
  if (folded.startsWith(query.whole)) return 1;
  const words = wordsOf(folded);
  if (query.tokens.every((t) => words.some((w) => w.startsWith(t)))) return 2;
  if (query.tokens.every((t) => folded.includes(t))) return 3;
  if (query.tokens.every((t) => folded.includes(t) || nearAWord(t, words))) return 4;
  return null;
}

/**
 * The items of `items` matching `query`, best tier first and, inside a tier, in the order given.
 * `labelsOf` names every text an item answers to (a name, an alias); the best of them counts.
 */
export function rankByLabels<T>(
  items: readonly T[],
  query: string | FoldedQuery,
  labelsOf: (item: T) => readonly string[]
): T[] {
  const q = typeof query === 'string' ? foldQuery(query) : query;
  if (q.tokens.length === 0) return [];
  const scored: { item: T; tier: number; order: number }[] = [];
  items.forEach((item, order) => {
    let best: number | null = null;
    for (const label of labelsOf(item)) {
      const tier = matchTier(label, q);
      if (tier !== null && (best === null || tier < best)) best = tier;
      if (best === 0) break;
    }
    if (best !== null) scored.push({ item, tier: best, order });
  });
  scored.sort((a, b) => a.tier - b.tier || a.order - b.order);
  return scored.map((s) => s.item);
}

/**
 * Whether a body of text (a message) holds every typed word, accent- and case-insensitively. No
 * typo tier here: a message is prose, and a tolerance over every word of every message would offer
 * a wrong hit for most short queries (the contract measures 0.05 wrong names per query on a roster,
 * not on free text).
 */
export function containsEveryToken(foldedText: string, query: FoldedQuery): boolean {
  return query.tokens.length > 0 && query.tokens.every((t) => foldedText.includes(t));
}
