import { associationVisibleToUserSql, memberRepostCarriesSql } from '../spaces/reader-spaces';

/**
 * A REPUBLICATION IS AN ASSOCIATION PUBLISHING, so the two feeds that list what associations
 * publish list what they republish too (user, 2026-10-24): a member's post the BDE republished is
 * ONE card in "Associations", and in "Suivis" for a reader who follows the BDE, "Republie par BDE".
 * The two arms used to read `posts."associationId"` alone, so a member's post the BDE carried
 * reached neither - only "Tout", under its first date.
 *
 * ONE ROW PER POST, BY CONSTRUCTION: the republication is an `EXISTS`, never a join, so a post
 * carried by two associations - or published by one and carried by another - is one card, and its
 * card names every republisher (`republishersOf`).
 *
 * THE REPOST'S DATE DECIDES ITS PLACE: a carried post sits at its LATEST counted republication, as a
 * repost does, and an uncarried one at its own `publishedAt`. A republication is always written
 * after the post is published, so `GREATEST` (which ignores the NULL of a post nobody carries) is
 * that latest date. The `OFFSET` pagination reads the same expression on every page.
 *
 * ONLY A REPUBLICATION THE READER COULD SEE COUNTS, for admission AND for placement: one by an
 * association the reader does not see (`associationVisibleToUserSql`, read grants included as on
 * every read path) neither puts the post in the feed nor moves it - otherwise the feed's order would
 * say that an association the reader cannot see has just republished something. The "Suivis" arm
 * narrows the count further to the associations the reader follows (`among`).
 *
 * WHO MAY SEE THE POST ITSELF IS NOT DECIDED HERE: each arm keeps every visibility, moderation,
 * block, promo and schedule clause it carries (`postVisibleToUserSql` already lets a republisher's
 * audience read a carried post).
 */

/**
 * The `FROM ... WHERE` of the republications of `posts` that count for the viewer whose id is the
 * placeholder `viewer`: by an association that viewer sees, and - with `among`, a `uuid[]`
 * placeholder - by one of those associations only. Never by an ARCHIVED association: it carries
 * the post to nobody (`republicationReachesUserSql`), so it neither admits nor dates a row (review
 * of #2965).
 */
function countedRepublicationsSql(alias: string, viewer: string, among?: string): string {
  const user = `${alias}_viewer`;
  const carrier = `${alias}_carrier`;
  const narrowed = among
    ? `\n             AND ${alias}."associationId" = ANY(${among}::uuid[])`
    : '';
  return `FROM post_republications ${alias}
           JOIN users ${user} ON ${user}.id = ${viewer}
           JOIN associations ${carrier} ON ${carrier}.id = ${alias}."associationId"
           WHERE ${alias}."postId" = posts.id
             AND NOT COALESCE(${carrier}.archived, false)
             AND ${associationVisibleToUserSql(`${alias}."associationId"`, user, { readGrants: true })}${narrowed}`;
}

/** The row carries at least one republication that counts for the viewer. */
export function republishedForViewerSql(viewer: string, among?: string): string {
  return `EXISTS (SELECT 1 ${countedRepublicationsSql('rf_in', viewer, among)})`;
}

/** The alias {@link followedRepostLateralSql} joins as. */
const FOLLOWED_REPOST = 'mf_followed';

/**
 * The latest MEMBER REPOST (WP-F6) of the row by one of `reposters` - a `text[]` placeholder, the
 * viewer's ACCEPTED follows (`FollowsService.getFollowedUserIdsForUser`) - that still CARRIES the
 * post to `viewer` (`memberRepostCarriesSql`: the reposter not muted, still seeing it first-hand, no
 * block, same cohort side), never for an anonymous post; NULL when there is none. A `LEFT JOIN
 * LATERAL` on `posts`, read as {@link FOLLOWED_REPOST_AT}.
 *
 * ONE evaluation per candidate row, read twice: the Suivis arm ADMITS a row on it and PLACES the row
 * at it ("a repost enters the Suivis feed at the time of the repost"). The two used to be two
 * subqueries, each running the carry check on every followed repost of every candidate. Whether the
 * viewer may READ the post is still the arm's own `postVisibleToViewerSql`; a stale row neither
 * surfaces a post nor dates it.
 *
 * `asOf` (a `timestamptz` SQL expression, Pour toi's ranking instant) counts only the reposts made
 * by then: a ranked list's tail is placed as of its ranking, so a repost written between two pages
 * neither admits a row nor moves one across the tail's cursor (`for-you-feed.ts`).
 */
export function followedRepostLateralSql(reposters: string, viewer: string, asOf?: string): string {
  const madeBy = asOf
    ? `
            AND mf_at."repostedAt" <= ${asOf}`
    : '';
  return `LEFT JOIN LATERAL (
         SELECT MAX(mf_at."repostedAt") AS at FROM member_reposts mf_at
           JOIN users mf_at_user ON mf_at_user.id = mf_at."reposterId"
          WHERE mf_at."postId" = posts.id AND mf_at."reposterId" = ANY(${reposters}::text[])
            AND NOT COALESCE(posts.anonymous, false)${madeBy}
            AND ${memberRepostCarriesSql('posts', 'mf_at_user', viewer)}) ${FOLLOWED_REPOST} ON true`;
}

/** The instant {@link followedRepostLateralSql} found, NULL when no followed repost carries the row. */
export const FOLLOWED_REPOST_AT = `${FOLLOWED_REPOST}.at`;

/** The row is admitted to Suivis by a followed person's repost ({@link followedRepostLateralSql}). */
export const MEMBER_REPOSTED_BY_FOLLOWED_SQL = `${FOLLOWED_REPOST_AT} IS NOT NULL`;

/**
 * The instant the row is placed at: its latest counted republication - and, with `repostedAt` (the
 * Suivis arm passes {@link FOLLOWED_REPOST_AT}), its latest member repost by someone the reader
 * follows - else its publication. `GREATEST` ignores a NULL.
 */
export function republishedFeedAtSql(viewer: string, among?: string, repostedAt?: string): string {
  const reposted = repostedAt ? `, ${repostedAt}` : '';
  return `GREATEST(posts."publishedAt",
           (SELECT MAX(rf_at."republishedAt") ${countedRepublicationsSql('rf_at', viewer, among)})${reposted})`;
}

/**
 * THE SUIVIS ADMISSION (`feed=followed`, chronological), kept unchanged for the installed clients
 * that still draw a Suivis tab; the 1.6.9 client's Pour toi reads {@link forYouFollowedSql}. `assoc` is the `uuid[]` placeholder of the followed associations, `users` the `text[]` one of the
 * accepted follows, `viewer` the reader's id. `join` goes after the `FROM posts ... LEFT JOIN
 * associations`, `admitted` in the `WHERE`, `at` is the instant the row is placed at.
 */
export function followedFeedSql(
  assoc: string,
  users: string,
  viewer: string
): { join: string; admitted: string; at: string } {
  return {
    join: followedRepostLateralSql(users, viewer),
    admitted: `(
         (posts."associationId" IS NOT NULL AND posts."associationId" = ANY(${assoc}::uuid[]))
         -- Never an anonymous post: appearing in THIS feed at all already says "written by
         -- someone in the small, known set you follow" - a leak no amount of masking the
         -- author's name removes, because the leak is membership, not the name.
         OR (posts."associationId" IS NULL AND posts."authorId" = ANY(${users}::text[])
             AND NOT posts.anonymous)
         -- What a followed association REPUBLISHED, never anonymous.
         OR (NOT COALESCE(posts.anonymous, false)
             AND ${republishedForViewerSql(viewer, assoc)})
         -- What a followed PERSON reposted (WP-F6), never anonymous: the lateral, read once
         -- for admission and once for placement.
         OR ${MEMBER_REPOSTED_BY_FOLLOWED_SQL}
       )`,
    at: republishedFeedAtSql(viewer, assoc, FOLLOWED_REPOST_AT),
  };
}

/**
 * POUR TOI'S FOLLOWED POSTS (owner, 2026-11-10): what the PEOPLE the reader follows WRITE or
 * REPOST - a personal post of an account they follow (never anonymous), or any post a followed
 * person reposted (WP-F6), an association's or an entity's included (owner, decision A: drawn with
 * its "X a repartage" header, from `repostedBy`). Never an entity's post nobody they follow
 * reposted, and nothing an association republished (both are the Associations tab's). Placed at the
 * latest followed repost, else at its publication. `users` is the `text[]` placeholder of the
 * accepted follows, `viewer` the reader's id, `asOf` the ranking's instant (reposts after it do not
 * count, {@link followedRepostLateralSql}). THE ONE SEAM of "people only" with
 * `suggestedPostIds(..., { peopleOnly: true })`.
 */
export function forYouFollowedSql(
  users: string,
  viewer: string,
  asOf?: string
): { join: string; admitted: string; at: string } {
  return {
    join: followedRepostLateralSql(users, viewer, asOf),
    admitted: `((posts."associationId" IS NULL AND posts."authorId" = ANY(${users}::text[])
          AND NOT posts.anonymous)
         OR ${MEMBER_REPOSTED_BY_FOLLOWED_SQL})`,
    at: `GREATEST(posts."publishedAt", ${FOLLOWED_REPOST_AT})`,
  };
}

/** The "Associations" feed: published by an association, or republished by one the viewer sees. */
export function inAssociationsFeedSql(viewer: string): string {
  return `(posts."associationId" IS NOT NULL
           OR ${republishedForViewerSql(viewer)})`;
}
