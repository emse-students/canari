import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * Accent- and case-insensitive SQL expression for the display name. Both search paths build on it,
 * so the fuzzy matching, substring matching, and similarity ranking all operate on the same
 * normalized text. Uses the `user` query-builder alias.
 */
export const NAME_NORM_EXPR = 'unaccent(LOWER(user.displayName))';

/**
 * Minimum term length before trigram fuzzy matching is added. Shorter terms (1-2 chars, e.g. the
 * start of an autocomplete) match by substring only: they have too few trigrams for
 * word_similarity to be meaningful and would otherwise pull in noise.
 */
export const FUZZY_MIN_TERM_LEN = 3;

/**
 * word_similarity threshold above which a term is accepted as a typo-tolerant match of a name.
 * Chosen so a single-character typo in a name still matches while unrelated names do not.
 */
export const FUZZY_TERM_THRESHOLD = 0.4;

/** Splits a raw search query into normalized whitespace-delimited terms (non-empty). */
export function splitSearchTerms(query: string): string[] {
  return (query ?? '').trim().split(/\s+/).filter(Boolean);
}

/** True when a term is long enough to benefit from trigram fuzzy matching. */
export function isFuzzyEligible(term: string): boolean {
  return term.length >= FUZZY_MIN_TERM_LEN;
}

/**
 * Adds accent-insensitive, word-order-insensitive, typo-tolerant display-name matching for
 * `rawQuery` to a user query builder, and orders results by closeness (best first).
 *
 * Matching: every whitespace term must match the name, either as a substring OR - for terms of at
 * least {@link FUZZY_MIN_TERM_LEN} characters - by trigram `word_similarity` above
 * {@link FUZZY_TERM_THRESHOLD}. AND-ing the terms keeps word order irrelevant (each term matches
 * anywhere), while the fuzzy branch tolerates typos.
 *
 * Ranking: a `search_score` column selects an exact whole-query substring match (boost) plus the
 * trigram `similarity` of the whole name to the whole query, and the results are ordered by it
 * (then by name for stable ties). Callers using `getMany()` get entities ordered by relevance; the
 * computed column is used only for ordering.
 *
 * Returns false (and touches nothing) when the query has no usable terms, so callers can decide
 * whether a query was actually applied.
 */
export function applyFuzzyNameSearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  rawQuery: string,
): boolean {
  const terms = splitSearchTerms(rawQuery);
  if (terms.length === 0) return false;

  const N = NAME_NORM_EXPR;
  terms.forEach((term, i) => {
    if (isFuzzyEligible(term)) {
      qb.andWhere(
        `(${N} LIKE unaccent(LOWER(:like${i})) OR word_similarity(unaccent(LOWER(:term${i})), ${N}) >= :fuzzyThreshold)`,
        {
          [`like${i}`]: `%${term}%`,
          [`term${i}`]: term,
          fuzzyThreshold: FUZZY_TERM_THRESHOLD,
        },
      );
    } else {
      qb.andWhere(`${N} LIKE unaccent(LOWER(:like${i}))`, {
        [`like${i}`]: `%${term}%`,
      });
    }
  });

  const trimmed = rawQuery.trim();
  qb.addSelect(
    `(CASE WHEN ${N} LIKE unaccent(LOWER(:wholeLike)) THEN 1 ELSE 0 END) + similarity(${N}, unaccent(LOWER(:wholeQuery)))`,
    'search_score',
  )
    .setParameter('wholeLike', `%${trimmed}%`)
    .setParameter('wholeQuery', trimmed)
    .orderBy('search_score', 'DESC')
    .addOrderBy('user.displayName', 'ASC');

  return true;
}
