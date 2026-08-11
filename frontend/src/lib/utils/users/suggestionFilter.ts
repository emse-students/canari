/**
 * Which of the search endpoint's answers a picker may actually offer.
 *
 * Extracted from `UserAutocomplete.svelte` so the rule can be tested: it is the only thing standing
 * between "you cannot invite someone who is already here" and a surface that offers them anyway.
 */

/** The shape every caller shares - the picker's own `User`, and anything structurally like it. */
export interface IdentifiedUser {
  id: string;
}

export interface SuggestionFilterOptions {
  /** IDs this surface already holds and must not offer again. */
  excludeIds?: readonly string[];
  /** When set, an allowlist: only these IDs may be offered at all. */
  filterUserIds?: readonly string[];
}

/**
 * Applies a surface's exclusion and allowlist rules to a set of search results.
 *
 * BOTH COMPARISONS ARE CASE-INSENSITIVE, and that is the substance of this function rather than a
 * detail of it. The same user id reaches different call sites in different cases - the multi-select
 * lowercases every id it stores, group rosters are compared lowercased elsewhere, and the search
 * endpoint returns ids as stored - so an exact-match exclusion is an exclusion that silently fails
 * to exclude, which is indistinguishable from not having wired one at all.
 *
 * @param results - what the server returned
 * @param options - the surrounding surface's rules
 * @returns the subset that may be shown, in the server's order
 */
export function filterUserSuggestions<T extends IdentifiedUser>(
  results: readonly T[],
  { excludeIds = [], filterUserIds }: SuggestionFilterOptions = {}
): T[] {
  const excluded = new Set(excludeIds.map((id) => id.toLowerCase()));
  const allowed = filterUserIds ? new Set(filterUserIds.map((id) => id.toLowerCase())) : null;
  return results.filter((user) => {
    const id = user.id.toLowerCase();
    return !excluded.has(id) && (!allowed || allowed.has(id));
  });
}
