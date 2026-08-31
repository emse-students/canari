/**
 * FOLDING TEXT FOR COMPARISON, in one place, because seven hand-rolled copies did not agree.
 *
 * Two questions are asked of a string in this app and neither is "what does it say": does it MATCH
 * what someone typed, and what IDENTIFIER does it produce. Both need accents removed, and both were
 * spelled out by hand at every call site - with three different regexes for the same idea
 * (`[̀-ͯ]`, `\p{Mn}`, `\p{Diacritic}`), which are three different character sets. Two
 * copies of one rule are a thing that can disagree; seven is a thing that does.
 *
 * The search half also has a property the copies could not have: {@link foldWithIndex} keeps a map
 * back to the ORIGINAL string, so a highlight drawn over a match lands on the characters that
 * matched. Folding changes length - `é` is one character and its decomposition is two - so an
 * index taken in folded space and used in original space is off by the number of accents before it.
 */

/** Every combining mark NFD can produce. `\p{M}` rather than a hand-picked range: see the header. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Lower-cases `text` and strips its diacritics, so "Reunion" and "Réunion" compare equal.
 *
 * The fold a HUMAN expects of a search box on a French corpus. Use it on both sides of a comparison
 * - folding only the query leaves "reunion" unable to find the accented spelling, which is the
 * defect this replaces.
 */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** A folded string, plus where each of its characters came from in the original. */
export interface FoldedText {
  /** The result of {@link foldForSearch}. */
  folded: string;
  /**
   * `sourceIndex[i]` is the offset in the ORIGINAL string that `folded[i]` came from, and there is
   * one extra entry at the end holding the original's length - so `sourceIndex[start]` and
   * `sourceIndex[end]` always bracket a slice, including one that ends at the very end.
   */
  sourceIndex: number[];
}

/**
 * Folds `text` and records, for every character of the result, where it came from in the original.
 *
 * WHY A MAP AND NOT A LENGTH ASSUMPTION. Folding is not length-preserving in general: a precomposed
 * `é` folds to one character, but the same letter written as `e` + `́` folds to one
 * character from TWO, and a string can hold both spellings. Anything that finds a match in folded
 * space and then slices the original - a highlighter, a snippet - must translate the offset or it
 * draws over the wrong characters, silently and only for accented text.
 *
 * Walks CODE POINTS, so an astral character (an emoji, say) is folded and mapped as one unit rather
 * than as two halves of a surrogate pair that could be split apart.
 */
export function foldWithIndex(text: string): FoldedText {
  let folded = '';
  const sourceIndex: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const piece = foldForSearch(ch);
    for (let i = 0; i < piece.length; i++) sourceIndex.push(offset);
    folded += piece;
    offset += ch.length;
  }
  // The end sentinel: a match ending at the last character needs an addressable end offset.
  sourceIndex.push(text.length);
  return { folded, sourceIndex };
}

/**
 * Turns a human label into a URL/id-safe slug: folded, then everything outside `[a-z0-9]` collapsed
 * to a single `-`, with no leading or trailing separator.
 *
 * Five call sites wrote this out, each with its own idea of which marks to strip, so the same
 * association name could slug differently depending on which screen created it. Empty in, empty out
 * - the caller decides whether that is acceptable, since a slug is usually an identifier and an
 * empty identifier is a different problem from an unslugifiable name.
 *
 * `maxLength` truncates and then trims again, because a cut landing on a separator would otherwise
 * leave the trailing `-` the rest of this function exists to remove - which is exactly the bug two
 * of the five copies had and the other three did not.
 */
export function slugify(label: string, maxLength?: number): string {
  const slug = foldForSearch(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return maxLength === undefined ? slug : slug.slice(0, maxLength).replace(/-+$/, '');
}
