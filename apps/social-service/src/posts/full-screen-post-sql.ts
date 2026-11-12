/**
 * A POST WHOSE ONLY CONTENT IS ONE PICTURE OR ONE VIDEO, as a clause over the `posts` row - what the
 * CanaReels list adds to the reels (`GET /api/posts?kind=reel&multiMedia=true`). Pictures since
 * 2026-10-19 (user: photos in CanaReels, as on Instagram); a video not filmed with the Canari camera,
 * a post of SEVERAL pictures and videos (the carousel pages) and a post with a LINK in its text (the
 * caption's link is tappable) since 2026-11-06 (owner). ONE SWITCH since 2026-11-11: the older
 * `singlePhotos`, `singleMedia` and `withLinks` each kept a narrower list for the clients that sent
 * them, and `minClientVersion` 1.6.6 left none of those clients (docs/wiki/legacy-compatibility.md).
 *
 * Exactly one attachment (`images` is the stored column of `media`), and that attachment a
 * picture (or a video): its `type`, or - for a row stored before `type` existed - its `mimeType`,
 * the same reading as the client's `resolveMediaType`.
 *
 * A VIDEO POST NEVER EXPIRES: only a reel (or a live replay) row has an `expiresAt`, and the
 * live-row clause (`posts."expiresAt" IS NULL OR ...`) leaves a plain post alone, so the video of a feed post
 * stays in the list as long as the post does.
 *
 * A COLUMN HOLDING JSON `null` (or any non-array) COUNTS AS EMPTY, never as an error:
 * `jsonb_array_length` RAISES on a scalar, and one such row would fail the whole page. The guard is
 * a `CASE`, whose branches PostgreSQL evaluates in order - an `OR` gives no such promise.
 *
 * KEPT OUT, because the page would drop what the post says: a poll or a form (a full-screen page
 * could not be answered), a linked calendar event (its card - date, place, the way to add it - is
 * not drawn on a page). A link in the text is NOT kept out: the page draws it in the caption. The
 * client reads one row the same way (`reels/fullScreenPost.ts`); both are pinned against the same
 * cases by `full-screen-post-sql.integration.spec.ts` and `fullScreenPost.test.ts`.
 *
 * WHO MAY SEE THE POST IS NOT DECIDED HERE: this narrows a feed arm that already carries every
 * visibility, moderation, block, promo and schedule clause a post has.
 */
const arrayLength = (column: string) =>
  `(CASE WHEN jsonb_typeof(${column}) = 'array' THEN jsonb_array_length(${column}) ELSE 0 END)`;

/** The one attachment is of this `type` (`image`, `video`), by its `type` or its legacy `mimeType`. */
const attachmentIs = (type: 'image' | 'video') =>
  `(posts.images->0->>'type' = '${type}'
             OR (posts.images->0->>'type' IS NULL AND posts.images->0->>'mimeType' LIKE '${type}/%'))`;

/** What the post says apart from its media: nothing a full-screen page would drop. */
const NOTHING_ELSE_SQL = `AND ${arrayLength('posts.polls')} = 0
           AND ${arrayLength('posts.forms')} = 0
           AND posts."attachedFormId" IS NULL
           AND posts."linkedCalendarEventId" IS NULL`;

/** One picture OR one video, nothing else. */
const SINGLE_MEDIA_POST_SQL = `${arrayLength('posts.images')} = 1
           AND (${attachmentIs('image')} OR ${attachmentIs('video')})
           ${NOTHING_ELSE_SQL}`;

/**
 * The most attachments a carousel page draws: Instagram's carousel cap. A post with more stays a
 * card in the feed (owner's request of 2026-11-06, the lead's bound).
 */
export const CAROUSEL_MAX_MEDIA = 10;

/**
 * Every attachment is a picture or a video, by its `type` or its legacy `mimeType`. A `CASE`, not
 * an `AND` after the length test: `jsonb_array_elements` RAISES on a scalar, and only `CASE`
 * promises PostgreSQL evaluates the guard first.
 */
const EVERY_ATTACHMENT_IS_VISUAL_SQL = `(CASE WHEN jsonb_typeof(posts.images) = 'array' THEN NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(posts.images) AS attachment
             WHERE NOT COALESCE(
               attachment->>'type' IN ('image', 'video')
               OR (attachment->>'type' IS NULL
                   AND (attachment->>'mimeType' LIKE 'image/%' OR attachment->>'mimeType' LIKE 'video/%')),
               false)
           ) ELSE false END)`;

/**
 * Two to {@link CAROUSEL_MAX_MEDIA} attachments, every one a picture or a video, nothing else: the
 * carousel pages of the `multiMedia=true` list (owner, 2026-11-06: a post of several photos and
 * videos in CanaReels, swiped left and right as on Instagram). A file or an audio among them keeps
 * the whole post out - a page draws pictures and videos only.
 */
const MULTI_MEDIA_POST_SQL = `${arrayLength('posts.images')} BETWEEN 2 AND ${CAROUSEL_MAX_MEDIA}
           AND ${EVERY_ATTACHMENT_IS_VISUAL_SQL}
           ${NOTHING_ELSE_SQL}`;

/**
 * The non-reel posts the CanaReels list adds to the reels: the single pages and the carousel pages,
 * a link in the text allowed. Poll, form, attached form and linked event keep a post out.
 */
export const FULL_SCREEN_POST_SQL = `((${SINGLE_MEDIA_POST_SQL}) OR (${MULTI_MEDIA_POST_SQL}))`;

/**
 * The one mode left, `carousel-links` (the name every cache key already carries): the CanaReels
 * list with its full-screen posts. Absent adds none.
 */
export type SingleMediaMode = 'carousel-links';

/** The clause of a mode. */
export const singleMediaSql = (_mode: SingleMediaMode): string => FULL_SCREEN_POST_SQL;

/**
 * The mode a request asks for: `multiMedia` turns the full-screen posts on; nothing else does. The
 * older switches (`singlePhotos`, `singleMedia`, `withLinks`) are no longer read: no client the
 * floor admits sends them without `multiMedia`, and the whitelisting ValidationPipe strips them.
 */
export const singleMediaModeOf = (p: { multiMedia?: boolean }): SingleMediaMode | undefined =>
  p.multiMedia === true ? 'carousel-links' : undefined;
