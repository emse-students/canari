/**
 * THE FULL-SCREEN REEL VIEWER'S NAVIGATION (C7), as pure functions: what a released drag means,
 * where it leads, which reels are mounted around the current one, and when the next page is asked
 * for. The component (`ReelViewer.svelte`) measures and draws; every decision is here, pinned by
 * `reelViewerNav.test.ts`.
 *
 * THE GESTURE MATH IS THE MEDIA VIEWER'S (`utils/viewerGestures.ts`), not a second copy: the axis is
 * locked by `classifyMove`, and a release is decided by `decideSwipe` - on the vertical axis for
 * paging, on the horizontal one for closing. A reel fills the screen and the next is BELOW it, as on
 * Instagram: dragging UP brings the next, DOWN the previous. A drag to the RIGHT closes the viewer
 * (the edge swipe a phone already reads as "back"); Back and the X do the same.
 *
 * A CAROUSEL PAGE (owner, 2026-11-06: a post of several photos and videos, as on Instagram) gives
 * the horizontal axis a second meaning: LEFT is the post's next media, RIGHT its previous one. The
 * vertical axis keeps paging POSTS, and the axis is still locked on the first movement, so a swipe
 * that curves never does both. Past either end of the strip a drag springs back: on the FIRST media a
 * drag to the right does NOT close the viewer (decided 2026-11-06 after review: a reader flicking
 * back through the media would close it by overshooting, and Instagram does not close there either);
 * Back and the X still do. A page of one media keeps the close on the right.
 */
import { decideSwipe, dragOffset, type GestureKind, type Point } from '$lib/utils/viewerGestures';

/** What a released drag asks for. */
export type ReelSwipeVerdict = 'next' | 'prev' | 'close' | 'stay' | 'media-next' | 'media-prev';

/** Where the current page is in its media: the visible one, out of how many (1 off a carousel). */
export interface MediaPosition {
  index: number;
  count: number;
}

export interface ReelRelease {
  /** The axis `classifyMove` locked the drag to. */
  kind: GestureKind;
  /** Travel since the finger landed, positive right / down. */
  dx: number;
  dy: number;
  /** `releaseVelocity` of the drag's samples, px/ms. */
  velocity: Point;
  /** The viewer's size. */
  width: number;
  height: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** The current page's media; absent or of one, the horizontal axis only closes. */
  media?: MediaPosition;
}

/** What a released drag means. A tap, a pinch or an undecided drag stays. */
export function reelReleaseVerdict(r: ReelRelease): ReelSwipeVerdict {
  if (r.kind === 'swipe-up' || r.kind === 'swipe-down') {
    const d = decideSwipe({
      dx: r.dy,
      velocityX: r.velocity.y,
      width: r.height,
      hasPrevious: r.hasPrevious,
      hasNext: r.hasNext,
    });
    return d === 'previous' ? 'prev' : d;
  }
  if (r.kind === 'swipe-h' && r.media && r.media.count > 1) {
    const d = decideSwipe({
      dx: r.dx,
      velocityX: r.velocity.x,
      width: r.width,
      hasPrevious: r.media.index > 0,
      hasNext: r.media.index < r.media.count - 1,
    });
    if (d === 'next') return 'media-next';
    if (d === 'previous') return 'media-prev';
    return 'stay';
  }
  if (r.kind === 'swipe-h') {
    // Only "previous" exists on this axis: a drag to the right is the way out, to the left nothing.
    const d = decideSwipe({
      dx: r.dx,
      velocityX: r.velocity.x,
      width: r.width,
      hasPrevious: true,
      hasNext: false,
    });
    return d === 'previous' ? 'close' : 'stay';
  }
  return 'stay';
}

/** Where a held drag puts things: the column of pages (`x`, `y`) and the current page's media strip. */
export interface ReelDrag extends Point {
  /** The horizontal offset of the current carousel's strip of media; 0 off a carousel. */
  mediaX: number;
}

/**
 * Where the reels sit while a drag is held: a vertical drag moves the column 1:1 towards an existing
 * neighbour and with resistance past either end; a horizontal one moves the reel right only (the
 * close), with the same resistance to the left. On a carousel a horizontal drag moves its STRIP of
 * media instead, 1:1 towards an existing media and with resistance past either end - the reel itself
 * never moves, since a carousel is not closed by a swipe.
 */
export function reelDragOffset(
  kind: GestureKind,
  dx: number,
  dy: number,
  hasPrevious: boolean,
  hasNext: boolean,
  media?: MediaPosition
): ReelDrag {
  if (kind === 'swipe-up' || kind === 'swipe-down') {
    return { x: 0, y: dragOffset(dy, hasPrevious, hasNext), mediaX: 0 };
  }
  if (kind === 'swipe-h' && media && media.count > 1) {
    return { x: 0, y: 0, mediaX: dragOffset(dx, media.index > 0, media.index < media.count - 1) };
  }
  if (kind === 'swipe-h') return { x: dragOffset(dx, true, false), y: 0, mediaX: 0 };
  return { x: 0, y: 0, mediaX: 0 };
}

/** The media index a verdict leads to inside a page of `count` media, clamped; others leave it. */
export function stepMediaIndex(index: number, verdict: ReelSwipeVerdict, count: number): number {
  if (count <= 1) return 0;
  if (verdict === 'media-next') return Math.min(index + 1, count - 1);
  if (verdict === 'media-prev') return Math.max(index - 1, 0);
  return index;
}

/**
 * WHICH MEDIA OF A PAGE ARE DRAWN, and how (owner's carousel, 2026-11-06). `show`: the media is in
 * the DOM at all - on the page on screen, the visible media and its two neighbours, so a swipe lands
 * on a drawn picture; on any other page, the media it will open on. `preload`: the media is fetched
 * ahead - the NEXT media of the page on screen once that page has settled, and the opening media of
 * the next page (the viewer's `preload`, already gated on the settle). The PREVIOUS media is held
 * the same way once the page has settled: it was fetched to be seen, so holding it is a cache hit,
 * and a swipe back lands on the picture rather than its ThumbHash. Only the visible media of
 * the page on screen is `active`, so only it can mount a player: a video anywhere else draws its
 * first frame and claims no playback.
 */
export function carouselMediaRole(
  paneIndex: number,
  page: { active: boolean; preload: boolean; settled: boolean; mediaIndex: number }
): { active: boolean; show: boolean; preload: boolean } {
  const visible = paneIndex === page.mediaIndex;
  if (page.active) {
    return {
      active: visible,
      show: Math.abs(paneIndex - page.mediaIndex) <= 1,
      preload: page.settled && Math.abs(paneIndex - page.mediaIndex) === 1,
    };
  }
  return { active: false, show: visible, preload: page.preload && visible };
}

/**
 * The index a verdict leads to. The ends do not wrap: `decideSwipe` already answers `stay` towards a
 * missing neighbour, and this clamps anyway so an index can never leave the list.
 */
export function stepReelIndex(index: number, verdict: ReelSwipeVerdict, count: number): number {
  if (count <= 0) return 0;
  if (verdict === 'next') return Math.min(index + 1, count - 1);
  if (verdict === 'prev') return Math.max(index - 1, 0);
  return index;
}

/**
 * The reels mounted around the current one: the previous, the current and the NEXT. The current one
 * plays; the next is the PRELOAD (its video is fetched and decrypted while the current plays), and
 * the previous keeps a swipe back instant. Everything further is unmounted and its media released.
 */
export function mountedReelIndices(index: number, count: number): number[] {
  const out: number[] = [];
  for (let i = index - 1; i <= index + 1; i++) if (i >= 0 && i < count) out.push(i);
  return out;
}

/** Ask for the next page once the reader is this close to the end of what is loaded. */
export const REEL_LOAD_AHEAD = 2;

/** Whether the next page should be asked for now. */
export function shouldLoadMoreReels(index: number, count: number, hasMore: boolean): boolean {
  return hasMore && count - 1 - index <= REEL_LOAD_AHEAD;
}

/**
 * The list the viewer pages through: the reel that was touched FIRST, then the reels the server
 * lists, without it. Instagram opens the touched reel and scrolls on into the others; a reel already
 * in the list is not shown twice when a later page repeats it.
 */
export function mergeReelPage<T extends { id: string }>(
  current: readonly T[],
  page: readonly T[]
): T[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...page.filter((r) => !seen.has(r.id))];
}
