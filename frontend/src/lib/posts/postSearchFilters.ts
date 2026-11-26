/**
 * THE POST SEARCH'S TWO FILTERS, client side (owner, 2026-11-19): a person and an association,
 * combinable with the typed words. The server decides what each one means and keeps every audience
 * rule (`apps/social-service/src/posts/post-search-filters.ts`); this file is the wire shape and the
 * pure helpers the picker and the page share.
 */

/** A filter once chosen: the id the server filters on, and the name the chip shows. */
export interface PostSearchPick {
  id: string;
  name: string;
}

/** What `GET /api/posts/search` is asked: the words and/or the two filters. */
export interface PostSearchCriteria {
  q: string;
  authorId?: string;
  associationId?: string;
}

/** Whether a search names anything to look for - the server answers `[]` to an empty one. */
export function hasSearchCriteria(criteria: PostSearchCriteria): boolean {
  return criteria.q.trim().length > 0 || !!criteria.authorId || !!criteria.associationId;
}

/** The query string of a search: the words, the filters set, and the page. */
export function searchQueryString(
  criteria: PostSearchCriteria,
  page: { limit?: number; offset?: number } = {}
): string {
  const p = new URLSearchParams({ q: criteria.q.trim() });
  if (criteria.authorId) p.set('authorId', criteria.authorId);
  if (criteria.associationId) p.set('associationId', criteria.associationId);
  if (page.limit != null) p.set('limit', String(page.limit));
  if (page.offset != null) p.set('offset', String(page.offset));
  return p.toString();
}

/** Lower-cases and strips accents, so "ecole" finds "École". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * The associations whose name contains what was typed, accent- and case-insensitively, in the
 * order given and capped at `limit` (the whole directory is never drawn as a list). An empty query
 * lists the first `limit`.
 */
export function matchAssociations<T extends { name: string }>(
  associations: readonly T[],
  query: string,
  limit = 30
): T[] {
  const needle = fold(query.trim());
  const hits = needle
    ? associations.filter((a) => fold(a.name).includes(needle))
    : [...associations];
  return hits.slice(0, limit);
}
