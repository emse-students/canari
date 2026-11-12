import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
import { isReplay } from '$lib/live/replayTimeline';
import { resolveMediaType } from '$lib/utils/mediaLayout';
import { resolveMediaSize, type MediaSize } from '$lib/utils/mediaFrame';

/**
 * WHAT THE CANAREELS VIEWER DRAWS AS A FULL-SCREEN PAGE (user, 2026-10-19; videos and carousels
 * added by the owner, 2026-11-06): a reel; a post whose ONLY content is ONE picture or ONE video;
 * and a post of TWO TO TEN pictures and videos, a `carousel` page whose media are swiped left and
 * right, as on Instagram. A video outside a reel (not filmed with the Canari camera) is drawn as a
 * `reel` page, and it never expires: only a row of kind `reel` has an `expiresAt`. A file or an
 * audio among the media, a poll or a form keep the post OUT - a page draws pictures and videos and
 * a caption, and a poll or a form drawn there could not be answered. A linked calendar event keeps
 * it out too: the card draws the event's card, and a page would silently drop it. A LINK IN THE
 * TEXT does not (owner, 2026-11-06): the caption draws it tappable, through the post's own
 * renderer (`PostMarkdown`); only its preview card is not drawn. A post of text alone is out:
 * there is nothing to look at.
 *
 * THE SERVER CHOOSES THE LIST (`GET /api/posts?kind=reel&multiMedia=true`, the same rule in SQL,
 * docs/wiki/services/reels.md); this is the CLIENT's reading of one row, so the slide knows which
 * page to draw and a row the rule does not cover is said in a log instead of drawn wrong.
 *
 * A LIVE REPLAY (`kind = 'replay'`, owner, 2026-11-09) IS A PAGE TOO, drawn as a reel from the live's
 * own segments (`ReplayPane`): it carries NO media of its own, so no rule about media applies to it,
 * and it comes only to a client that asked (`withReplays`).
 */
export type FullScreenPage = 'reel' | 'photo' | 'carousel' | 'replay';

/** The most media a carousel page draws (the server's `CAROUSEL_MAX_MEDIA`, Instagram's cap). */
export const CAROUSEL_MAX_MEDIA = 10;

/** The attachments of a post: `media`, or `images` from a server older than the rename. */
function mediaOf(post: Partial<Pick<PostEntity, 'media' | 'images'>>): PostMediaRef[] {
  return post.media ?? post.images ?? [];
}

/** How one media of a page is drawn: a picture, or a video with its player. */
export type FullScreenMediaKind = 'photo' | 'video';

/** A picture or a video, else `null` (a file, an audio): the only media a page draws. */
export function fullScreenMediaKindOf(ref: PostMediaRef): FullScreenMediaKind | null {
  const type = resolveMediaType(ref);
  return type === 'image' ? 'photo' : type === 'video' ? 'video' : null;
}

/**
 * The page a post is drawn as in the CanaReels viewer, or `null` when it has none: a reel, and a post
 * with exactly one video, is a `reel` page; exactly one picture, a `photo` page; two to ten pictures
 * and videos, a `carousel` page. Never with a poll, a form or a linked event; a link in the text is
 * drawn in the caption.
 */
export function fullScreenPageOf(
  post: Pick<
    PostEntity,
    'kind' | 'media' | 'images' | 'polls' | 'forms' | 'attachedFormId' | 'linkedCalendarEventId'
  >
): FullScreenPage | null {
  if (isReplay(post)) return 'replay';
  if (isReel(post)) return 'reel';
  const media = mediaOf(post);
  if (media.length === 0 || media.length > CAROUSEL_MAX_MEDIA) return null;
  const kinds = media.map(fullScreenMediaKindOf);
  if (kinds.some((k) => k === null)) return null;
  if ((post.polls?.length ?? 0) > 0 || (post.forms?.length ?? 0) > 0 || post.attachedFormId) {
    return null;
  }
  if (post.linkedCalendarEventId) return null;
  if (media.length > 1) return 'carousel';
  return kinds[0] === 'video' ? 'reel' : 'photo';
}

/** The one picture of a `photo` page, or the one video of a `reel` page (a reel, or a post of one video). */
export function fullScreenMediaOf(
  post: Partial<Pick<PostEntity, 'media' | 'images'>>
): PostMediaRef | undefined {
  return mediaOf(post)[0];
}

/** Every media of a page, in the post's order: one for a reel or a photo page, 2..10 for a carousel. */
export function fullScreenMediaListOf(
  post: Partial<Pick<PostEntity, 'media' | 'images'>>
): PostMediaRef[] {
  return mediaOf(post);
}

/**
 * Whether the media on show is a LANDSCAPE VIDEO - the one case where the pager turns with the phone
 * (owner, 2026-11-12, issue #3407; screen-orientation.md). Landscape is the media's own shape,
 * width > height, from `resolveMediaSize`: the DECLARED size first (it wins, and exists before the
 * player mounts), else `measured` - what this device measured of an older post (videos posted before
 * 2026-09-29 declare no size): the shared size cache, then the decoded video's own size once it
 * reported. A square or vertical video, a photo, a replay and a media of unknown size are `false`,
 * so the pager stays portrait for them.
 */
export function isLandscapeVideo(
  media: PostMediaRef | undefined,
  measured: MediaSize | null = null
): boolean {
  if (!media || fullScreenMediaKindOf(media) !== 'video') return false;
  const size = resolveMediaSize({ width: media.width, height: media.height }, measured);
  return size !== null && size.width > size.height;
}

/**
 * The media of `post` that is on show: the page's one media, or a carousel's visible one (clamped).
 * `undefined` for a replay, which carries no media of its own.
 */
export function visibleMediaOf(
  post: Partial<Pick<PostEntity, 'media' | 'images'>> | undefined,
  mediaIndex: number
): PostMediaRef | undefined {
  if (!post) return undefined;
  const list = mediaOf(post);
  return list[Math.min(Math.max(mediaIndex, 0), Math.max(list.length - 1, 0))];
}
