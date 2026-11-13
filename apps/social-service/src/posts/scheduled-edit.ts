/**
 * THE CANDIDATES FOR "MY SCHEDULED POSTS" (owner, 2026-11-13): every future-scheduled post the
 * caller could possibly edit - their own PERSONAL posts, and every post in an association's name.
 * It is deliberately a superset: who may really edit is `PostsService.isPublisherOf` (the predicate
 * `updatePost` applies), asked once per association in `getScheduledPostsIMayEdit`. The SQL never
 * decides rights, so there is one implementation of them.
 *
 * Soonest first. A scheduled post is a text post: reels and replays are never scheduled.
 */
export const SCHEDULED_EDIT_CANDIDATES_SQL = `SELECT id, "authorId", "associationId"
  FROM posts
  WHERE "scheduledAt" IS NOT NULL
    AND "scheduledAt" > NOW()
    AND (kind IS NULL OR kind NOT IN ('reel', 'replay'))
    AND ("associationId" IS NOT NULL OR "authorId" = $1)
  ORDER BY "scheduledAt" ASC, id ASC`;

/** The most scheduled posts one editor is handed; the strip above the feed is not an agenda. */
export const SCHEDULED_EDIT_LIMIT = 20;
