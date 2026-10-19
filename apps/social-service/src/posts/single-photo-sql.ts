/**
 * A POST WHOSE ONLY CONTENT IS ONE PICTURE, as a clause over the `posts` row - what the CanaReels
 * list adds to the reels (user, 2026-10-19: photos in CanaReels, as on Instagram;
 * `GET /api/posts?kind=reel&singlePhotos=true`).
 *
 * Exactly one attachment (`images` is the stored column of `media`), and that attachment a
 * picture: its `type`, or - for a row stored before `type` existed - its `mimeType`, the same
 * reading as the client's `resolveMediaType`.
 *
 * A COLUMN HOLDING JSON `null` (or any non-array) COUNTS AS EMPTY, never as an error:
 * `jsonb_array_length` RAISES on a scalar, and one such row would fail the whole page. The guard is
 * a `CASE`, whose branches PostgreSQL evaluates in order - an `OR` gives no such promise.
 *
 * KEPT OUT, because the page would drop what the post says: a poll or a form (a full-screen page
 * could not be answered), a linked calendar event (its card - date, place, the way to add it - is
 * not drawn on a page) and a link in the text (the card draws its preview, the page does not). The
 * link test is a SUPERSET of the client's `extractFirstUrl` (any `http(s)://`), so a row this lets
 * through is never one the client would read as carrying a preview. The client reads one row the
 * same way (`reels/fullScreenPost.ts`); both are pinned against the same cases by
 * `single-photo-sql.integration.spec.ts` and `fullScreenPost.test.ts`.
 *
 * WHO MAY SEE THE POST IS NOT DECIDED HERE: this narrows a feed arm that already carries every
 * visibility, moderation, block, promo and schedule clause a post has.
 */
const arrayLength = (column: string) =>
  `(CASE WHEN jsonb_typeof(${column}) = 'array' THEN jsonb_array_length(${column}) ELSE 0 END)`;

export const SINGLE_PHOTO_POST_SQL = `${arrayLength('posts.images')} = 1
           AND (
             posts.images->0->>'type' = 'image'
             OR (posts.images->0->>'type' IS NULL AND posts.images->0->>'mimeType' LIKE 'image/%')
           )
           AND ${arrayLength('posts.polls')} = 0
           AND ${arrayLength('posts.forms')} = 0
           AND posts."attachedFormId" IS NULL
           AND posts."linkedCalendarEventId" IS NULL
           AND COALESCE(posts.markdown, '') !~* 'https?://'`;
