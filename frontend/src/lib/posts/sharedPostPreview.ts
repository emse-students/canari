import { getPost, isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import { postAuthorDisplayName } from '$lib/utils/canariLinkPreviewFormat';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { currentUserId } from '$lib/stores/user';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * WHAT THE SHARED-POST BUBBLE DRAWS (`SharedPostCard`): the Instagram-style card of a post or a
 * CanaReel whose link was sent into a conversation or a channel. The message itself stays a bare
 * link, so an older app keeps drawing its generic card; this card is how a NEW app reads the same
 * link. The post is read with the RECIPIENT's session (`getPost`), so a post that reader may not
 * see - deleted, an expired reel, private, from a blocked author - comes back refused and the card
 * draws {@link SharedPostPreview} `unavailable`, never a thumbnail and never any of its text.
 */

/** The longest caption kept: the card clamps it to three lines, this only bounds the string. */
export const SHARED_POST_CAPTION_MAX = 240;

/** Ratios the preview may take, width over height: Instagram's feed crop, 4:5 to 16:9. */
const MIN_ASPECT = 4 / 5;
const MAX_ASPECT = 16 / 9;
/** A reel is always the tall card, whatever its file declares. */
export const SHARED_REEL_ASPECT = 9 / 16;

/** The preview of a post the reader may see. */
export interface SharedPostReady {
  state: 'ready';
  postId: string;
  /** The post, for the avatar choice (`PostAuthorAvatar`) - never rendered as a whole. */
  post: PostEntity;
  authorName: string;
  /** Plain text, bounded; empty when the post has none. */
  caption: string;
  /** The first picture or video, or `null` for a text-only post (or a file / audio first). */
  media: PostMediaRef | null;
  mediaKind: 'image' | 'video' | null;
  isReel: boolean;
  /** Width over height of the preview box. */
  aspect: number;
  /** The reel the viewer opens, when this is one. */
  reelPost: PostEntity | null;
}

/** A post this reader cannot see, or that no longer exists. Carries nothing of the post. */
export interface SharedPostUnavailable {
  state: 'unavailable';
}

export type SharedPostPreview = SharedPostReady | SharedPostUnavailable;

/** The statuses that are a VERDICT about the post (it is gone or closed to this reader). */
const VERDICT_STATUSES = new Set([401, 403, 404, 410]);

/** The ratio of the preview box for a media of `width` x `height`. */
export function sharedPostAspect(
  reel: boolean,
  media: Pick<PostMediaRef, 'width' | 'height'> | null
): number {
  if (reel) return SHARED_REEL_ASPECT;
  const w = media?.width;
  const h = media?.height;
  if (!w || !h || w <= 0 || h <= 0) return 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, w / h));
}

/** Builds the ready preview of a post the reader was served. */
export function sharedPostReady(post: PostEntity): SharedPostReady {
  const first = post.media?.[0] ?? null;
  const kind = first?.type === 'image' || first?.type === 'video' ? first.type : null;
  const media = kind ? first : null;
  const reel = isReel(post);
  return {
    state: 'ready',
    postId: post.id,
    post,
    authorName: post.anonymous ? m.post_anonymous_label() : postAuthorDisplayName(post),
    caption: truncateForMeta(markdownToPlainText(post.markdown ?? ''), SHARED_POST_CAPTION_MAX),
    media,
    mediaKind: kind,
    isReel: reel,
    aspect: sharedPostAspect(reel, media),
    reelPost: reel ? post : null,
  };
}

const CACHE_MAX = 80;
/**
 * Verdicts and ready previews, keyed by VIEWER and post id: a verdict is about what ONE reader may
 * see, so an account switch on the same install can never read the previous account's answer.
 * Insertion order is the eviction order.
 */
const cache = new Map<string, SharedPostPreview>();
/** Reads in flight, so two bubbles of one post (or a remount) share ONE request. */
const inFlight = new Map<string, Promise<SharedPostPreview>>();

function keyOf(postId: string): string {
  return `${currentUserId() ?? ''}:${postId}`;
}

/** The preview already read for `postId` by this viewer, or `null`: lets a remounted row paint at once. */
export function cachedSharedPostPreview(postId: string): SharedPostPreview | null {
  return cache.get(keyOf(postId)) ?? null;
}

function remember(key: string, preview: SharedPostPreview): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, preview);
}

/** Forgets everything read (tests). */
export function clearSharedPostPreviews(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Reads the post under the CURRENT session. A refusal that is a verdict (401/403/404/410) is cached
 * as `unavailable`; any other failure (no network, a 5xx) is returned as `unavailable` too but NOT
 * cached, so the next mount asks again - a dead link must not turn a post into a tombstone for the
 * session. No batched post read exists on the server, so the one-request-per-visible-card rule is
 * kept by the card's own viewport gate and by this cache.
 */
export function fetchSharedPostPreview(postId: string): Promise<SharedPostPreview> {
  const key = keyOf(postId);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async (): Promise<SharedPostPreview> => {
    try {
      const preview = sharedPostReady(await getPost(postId));
      remember(key, preview);
      return preview;
    } catch (error) {
      const status = refusalStatus(error);
      Log.d(
        'SHARED_POST',
        `post ${postId.slice(0, 8)} unavailable (${status ?? 'no answer'}): ${String(error)}`
      );
      const gone: SharedPostUnavailable = { state: 'unavailable' };
      if (status !== null && VERDICT_STATUSES.has(status)) remember(key, gone);
      return gone;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
  return work;
}
