import { associationVisibleToUserSql } from '../spaces/reader-spaces';

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
 * placeholder - by one of those associations only.
 */
function countedRepublicationsSql(alias: string, viewer: string, among?: string): string {
  const user = `${alias}_viewer`;
  const narrowed = among
    ? `\n             AND ${alias}."associationId" = ANY(${among}::uuid[])`
    : '';
  return `FROM post_republications ${alias}
           JOIN users ${user} ON ${user}.id = ${viewer}
           WHERE ${alias}."postId" = posts.id
             AND ${associationVisibleToUserSql(`${alias}."associationId"`, user, { readGrants: true })}${narrowed}`;
}

/** The row carries at least one republication that counts for the viewer. */
export function republishedForViewerSql(viewer: string, among?: string): string {
  return `EXISTS (SELECT 1 ${countedRepublicationsSql('rf_in', viewer, among)})`;
}

/** The instant the row is placed at: its latest counted republication, else its publication. */
export function republishedFeedAtSql(viewer: string, among?: string): string {
  return `GREATEST(posts."publishedAt",
           (SELECT MAX(rf_at."republishedAt") ${countedRepublicationsSql('rf_at', viewer, among)}))`;
}

/** The "Associations" feed: published by an association, or republished by one the viewer sees. */
export function inAssociationsFeedSql(viewer: string): string {
  return `(posts."associationId" IS NOT NULL
           OR ${republishedForViewerSql(viewer)})`;
}
