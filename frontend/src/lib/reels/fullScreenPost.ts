import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
import { resolveMediaType } from '$lib/utils/mediaLayout';
import { extractFirstUrl } from '$lib/utils/chat/messageDisplay';

/**
 * WHAT THE CANAREELS VIEWER DRAWS AS A FULL-SCREEN PAGE (user, 2026-10-19): a reel, and a post whose
 * ONLY content is ONE picture. Several media, a video outside a reel, a file, a poll or a form keep
 * the post OUT - a page has room for one picture and a caption, and a poll or a form drawn there
 * could not be answered. A linked calendar event or a link in the text keep it out too: the card
 * draws the event's card and the link's preview, and a page would silently drop them. A post of
 * text alone is out: there is nothing to look at.
 *
 * THE SERVER CHOOSES THE LIST (`GET /api/posts?kind=reel&singlePhotos=true`, the same rule in SQL,
 * docs/wiki/services/reels.md); this is the CLIENT's reading of one row, so the slide knows which
 * page to draw and a row the rule does not cover is said in a log instead of drawn wrong.
 */
export type FullScreenPage = 'reel' | 'photo';

/** The attachments of a post: `media`, or `images` from a server older than the rename. */
function mediaOf(post: Pick<PostEntity, 'media' | 'images'>): PostMediaRef[] {
  return post.media ?? post.images ?? [];
}

/**
 * The page a post is drawn as in the CanaReels viewer, or `null` when it has none: a reel is a
 * `reel` page, a post with exactly one picture and no poll or form is a `photo` page.
 */
export function fullScreenPageOf(
  post: Pick<
    PostEntity,
    | 'kind'
    | 'media'
    | 'images'
    | 'polls'
    | 'forms'
    | 'attachedFormId'
    | 'linkedCalendarEventId'
    | 'markdown'
  >
): FullScreenPage | null {
  if (isReel(post)) return 'reel';
  const media = mediaOf(post);
  if (media.length !== 1 || resolveMediaType(media[0]) !== 'image') return null;
  if ((post.polls?.length ?? 0) > 0 || (post.forms?.length ?? 0) > 0 || post.attachedFormId) {
    return null;
  }
  if (post.linkedCalendarEventId || (post.markdown && extractFirstUrl(post.markdown))) return null;
  return 'photo';
}

/** The one picture of a `photo` page, or the one video of a reel. */
export function fullScreenMediaOf(
  post: Pick<PostEntity, 'media' | 'images'>
): PostMediaRef | undefined {
  return mediaOf(post)[0];
}
