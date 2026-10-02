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
 */
import { decideSwipe, dragOffset, type GestureKind, type Point } from '$lib/utils/viewerGestures';

/** What a released drag asks for. */
export type ReelSwipeVerdict = 'next' | 'prev' | 'close' | 'stay';

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

/**
 * Where the reels sit while a drag is held: a vertical drag moves the column 1:1 towards an existing
 * neighbour and with resistance past either end; a horizontal one moves the reel right only (the
 * close), with the same resistance to the left.
 */
export function reelDragOffset(
  kind: GestureKind,
  dx: number,
  dy: number,
  hasPrevious: boolean,
  hasNext: boolean
): Point {
  if (kind === 'swipe-up' || kind === 'swipe-down') {
    return { x: 0, y: dragOffset(dy, hasPrevious, hasNext) };
  }
  if (kind === 'swipe-h') return { x: dragOffset(dx, true, false), y: 0 };
  return { x: 0, y: 0 };
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
