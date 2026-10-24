/**
 * WHAT THE "ASSOCIATIONS" FEED HOLDS, AND WHERE EACH ROW SITS - two clauses over the `posts` row.
 *
 * The feed is what associations PUBLISH, and a republication is an association publishing (D38,
 * D38b; user, 2026-10-24: a post republished by the BDE appears there as ONE card, the repost, with
 * "Republie par BDE"). So a row is in it when an association published it OR republished it. The
 * arm used to read `posts."associationId" IS NOT NULL` alone, so a member's post the BDE carried
 * never reached the feed at all - only the "Tous" feed, under its first date.
 *
 * ONE ROW PER POST, BY CONSTRUCTION: the republication is an `EXISTS`, never a join, so a post
 * carried by two associations - or published by one and carried by another - is one card, and its
 * card names every republisher (`republishersOf`).
 *
 * THE REPOST'S DATE DECIDES ITS PLACE: a carried post sits at its LATEST republication, as a repost
 * does, and an uncarried one at its own `publishedAt`. A republication is always written after the
 * post is published, so `GREATEST` (which ignores the NULL of a post nobody carries) is that latest
 * date. The `OFFSET` pagination reads the same expression on every page, so a page boundary moves
 * with it rather than splitting a card.
 *
 * WHO MAY SEE THE POST IS NOT DECIDED HERE: the arm keeps every visibility, moderation, block, promo
 * and schedule clause it carries. `postVisibleToUserSql` already lets a republisher's audience read
 * a carried post; this only stops the feed from leaving it out.
 */

/** The row is published OR republished by an association. */
export const IN_ASSOCIATIONS_FEED_SQL = `(posts."associationId" IS NOT NULL
           OR EXISTS (SELECT 1 FROM post_republications af_pr WHERE af_pr."postId" = posts.id))`;

/** The instant the row is placed at in this feed: its latest republication, else its publication. */
export const ASSOCIATIONS_FEED_AT_SQL = `GREATEST(posts."publishedAt",
           (SELECT MAX(af_at."republishedAt") FROM post_republications af_at WHERE af_at."postId" = posts.id))`;
