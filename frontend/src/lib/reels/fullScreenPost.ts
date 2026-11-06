import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
import { resolveMediaType } from '$lib/utils/mediaLayout';
import { extractFirstUrl } from '$lib/utils/chat/messageDisplay';

/**
 * WHAT THE CANAREELS VIEWER DRAWS AS A FULL-SCREEN PAGE (user, 2026-10-19; videos added by the
 * owner, 2026-11-06): a reel, and a post whose ONLY content is ONE picture or ONE video. A video
 * outside a reel (not filmed with the Canari camera) is drawn as a `reel` page, and it never
 * expires: only a row of kind `reel` has an `expiresAt`. Several media, a file, a poll or a form
 * keep the post OUT - a page has room for one picture or video and a caption, and a poll or a form
 * drawn there could not be answered. A linked calendar event or a link in the text keep it out
 * too: the card draws the event's card and the link's preview, and a page would silently drop
 * them. A post of text alone is out: there is nothing to look at.
 *
 * THE SERVER CHOOSES THE LIST (`GET /api/posts?kind=reel&singleMedia=true`, the same rule in SQL,
 * docs/wiki/services/reels.md); this is the CLIENT's reading of one row, so the slide knows which
 * page to draw and a row the rule does not cover is said in a log instead of drawn wrong.
 */
export type FullScreenPage = 'reel' | 'photo';

/** The attachments of a post: `media`, or `images` from a server older than the rename. */
function mediaOf(post: Partial<Pick<PostEntity, 'media' | 'images'>>): PostMediaRef[] {
  return post.media ?? post.images ?? [];
}

/**
 * The page a post is drawn as in the CanaReels viewer, or `null` when it has none: a reel, and a post
 * with exactly one video and no poll or form, is a `reel` page; exactly one picture, a `photo` page.
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
  const type = media.length === 1 ? resolveMediaType(media[0]) : null;
  if (type !== 'image' && type !== 'video') return null;
  if ((post.polls?.length ?? 0) > 0 || (post.forms?.length ?? 0) > 0 || post.attachedFormId) {
    return null;
  }
  if (post.linkedCalendarEventId || (post.markdown && extractFirstUrl(post.markdown))) return null;
  return type === 'video' ? 'reel' : 'photo';
}

/** The one picture of a `photo` page, or the one video of a `reel` page (a reel, or a post of one video). */
export function fullScreenMediaOf(
  post: Partial<Pick<PostEntity, 'media' | 'images'>>
): PostMediaRef | undefined {
  return mediaOf(post)[0];
}
