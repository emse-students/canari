/**
 * A POST WHOSE ONLY CONTENT IS ONE PICTURE OR ONE VIDEO, as a clause over the `posts` row - what the
 * CanaReels list adds to the reels. Pictures since 2026-10-19 (user: photos in CanaReels, as on
 * Instagram; `GET /api/posts?kind=reel&singlePhotos=true`); a video not filmed with the Canari
 * camera since 2026-11-06 (owner; `singleMedia=true`, which answers pictures AND videos); a post of
 * SEVERAL pictures and videos since 2026-11-06 too (owner; `multiMedia=true`, the carousel pages,
 * `MULTI_MEDIA_POST_SQL` below). And since 2026-11-06 (owner), a post with a LINK in its text
 * comes too when the client says it draws one (`withLinks=true`, the caption's link is tappable).
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
 * not drawn on a page). A LINK IN THE TEXT kept the post out until 2026-11-06 (the card draws its
 * preview, the page did not); the owner then decided such a post belongs in CanaReels with the link
 * tappable in the caption. The old rule stays for every client that does not send `withLinks`
 * (docs/wiki/legacy-compatibility.md): those clients read a row with a link as no page at all. The
 * link test is a SUPERSET of the client's `extractFirstUrl` (any `http(s)://`), so a row the old
 * rule lets through is never one such a client would read as carrying a preview. The client reads
 * one row the same way (`reels/fullScreenPost.ts`); both are pinned against the same cases by
 * `full-screen-post-sql.integration.spec.ts` and `fullScreenPost.test.ts`.
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

/**
 * Whether a link in the text keeps the post out: `kept-out` for every client that does not send
 * `withLinks` (the rule up to 2026-11-06), `allowed` for the one that draws the link in its caption.
 */
type LinkRule = 'kept-out' | 'allowed';

/** What the post says apart from its media: nothing a full-screen page would drop. */
const nothingElseSql = (links: LinkRule) => `AND ${arrayLength('posts.polls')} = 0
           AND ${arrayLength('posts.forms')} = 0
           AND posts."attachedFormId" IS NULL
           AND posts."linkedCalendarEventId" IS NULL${
             links === 'kept-out'
               ? `\n           AND COALESCE(posts.markdown, '') !~* 'https?://'`
               : ''
           }`;

const singlePhotoSql = (links: LinkRule) => `${arrayLength('posts.images')} = 1
           AND ${attachmentIs('image')}
           ${nothingElseSql(links)}`;

const singleMediaPostSql = (links: LinkRule) => `${arrayLength('posts.images')} = 1
           AND (${attachmentIs('image')} OR ${attachmentIs('video')})
           ${nothingElseSql(links)}`;

/** One picture, nothing else: the `singlePhotos=true` list, which an installed client still asks. */
export const SINGLE_PHOTO_POST_SQL = singlePhotoSql('kept-out');

/** One picture OR one video, nothing else: the `singleMedia=true` list. */
export const SINGLE_MEDIA_POST_SQL = singleMediaPostSql('kept-out');

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
const multiMediaPostSql = (
  links: LinkRule
) => `${arrayLength('posts.images')} BETWEEN 2 AND ${CAROUSEL_MAX_MEDIA}
           AND ${EVERY_ATTACHMENT_IS_VISUAL_SQL}
           ${nothingElseSql(links)}`;

export const MULTI_MEDIA_POST_SQL = multiMediaPostSql('kept-out');

/**
 * The single and carousel pages again, a LINK IN THE TEXT ALLOWED (owner, 2026-11-06): the
 * `withLinks=true` list. Poll, form, attached form and linked event still keep a post out.
 */
export const LINKED_MEDIA_POST_SQL = `((${singleMediaPostSql('allowed')}) OR (${multiMediaPostSql('allowed')}))`;

/**
 * Which non-reel posts the CanaReels list adds to the reels; absent adds none. `photos`: one
 * picture; `media`: one picture or one video; `carousel`: those, AND several pictures and videos;
 * `carousel-links`: the same, a link in the text allowed.
 */
export type SingleMediaMode = 'photos' | 'media' | 'carousel' | 'carousel-links';

/** The clause of a mode. */
export const singleMediaSql = (mode: SingleMediaMode): string => {
  if (mode === 'carousel-links') return LINKED_MEDIA_POST_SQL;
  if (mode === 'carousel') return `((${SINGLE_MEDIA_POST_SQL}) OR (${MULTI_MEDIA_POST_SQL}))`;
  return mode === 'media' ? SINGLE_MEDIA_POST_SQL : SINGLE_PHOTO_POST_SQL;
};

/**
 * The mode a request asks for: `multiMedia` wins over `singleMedia`, which wins over
 * `singlePhotos`; none means none. `withLinks` means something only WITH `multiMedia` - the client
 * that draws a caption's link draws carousels too, and an older switch alone keeps its old rule.
 * Each older switch keeps its own meaning for the installed client that sends it
 * (docs/wiki/legacy-compatibility.md): a client that cannot draw a carousel never receives one,
 * and one that drops a caption's link never receives a post that has one.
 */
export const singleMediaModeOf = (p: {
  withLinks?: boolean;
  multiMedia?: boolean;
  singleMedia?: boolean;
  singlePhotos?: boolean;
}): SingleMediaMode | undefined =>
  p.multiMedia === true
    ? p.withLinks === true
      ? 'carousel-links'
      : 'carousel'
    : p.singleMedia === true
      ? 'media'
      : p.singlePhotos === true
        ? 'photos'
        : undefined;
