/**
 * THE POST SEARCH'S TWO FILTERS (owner, 2026-11-19: *"filtrer les posts d'une personne, ou d'une
 * asso"*), combinable with the words. One implementation of what they mean, so the query and its
 * spec cannot disagree.
 *
 * A filter NARROWS and never widens: it is one more `AND` beside the audience, block, hidden and
 * promo clauses `searchPosts` already carries.
 */

/** The optional filters of `GET /posts/search`. */
export interface PostSearchFilters {
  /** A person: their PERSONAL, non-anonymous posts. */
  authorId?: string;
  /** An association: the posts published as it. */
  associationId?: string;
}

/** Whether a search names anything to look for: words, or at least one filter. */
export function hasPostSearchCriteria(term: string, filters: PostSearchFilters): boolean {
  return term.length > 0 || !!filters.authorId?.trim() || !!filters.associationId?.trim();
}

/**
 * The `AND ...` clauses the words and the filters add to the search, each value bound through
 * `bind` (which pushes the value and returns its 1-based placeholder number).
 *
 * A PERSON IS THEIR PERSONAL POSTS ONLY: an association's post is stored with the officer's id as
 * `authorId`, and filtering on it would tell the reader which officer typed it - the one fact the
 * feed never shows. An anonymous post is withheld the same way.
 */
export function postSearchFilterSql(
  term: string,
  filters: PostSearchFilters,
  bind: (value: unknown) => number
): string {
  const clauses: string[] = [];
  if (term) {
    const like = bind(`%${term}%`);
    clauses.push(`AND (posts.markdown ILIKE $${like} OR assoc.name ILIKE $${like})`);
  }
  const authorId = filters.authorId?.trim();
  if (authorId) {
    clauses.push(
      `AND posts."associationId" IS NULL AND NOT COALESCE(posts.anonymous, false) AND posts."authorId" = $${bind(authorId)}`
    );
  }
  const associationId = filters.associationId?.trim();
  if (associationId) clauses.push(`AND posts."associationId" = $${bind(associationId)}::uuid`);
  return clauses.join('\n         ');
}
