/**
 * The viewer's navigation, decided by numbers and never by a clock: what a released drag means,
 * where it leads, what stays mounted, when the next page is asked for.
 */
import { describe, expect, it } from 'vitest';
import {
  carouselMediaRole,
  mergeReelPage,
  mountedReelIndices,
  reelDragOffset,
  reelReleaseVerdict,
  shouldLoadMoreReels,
  stepMediaIndex,
  stepReelIndex,
  type ReelRelease,
} from './reelViewerNav';

const base = { width: 400, height: 800, hasPrevious: true, hasNext: true };
const release = (r: Partial<ReelRelease>): ReelRelease => ({
  kind: 'pending',
  dx: 0,
  dy: 0,
  velocity: { x: 0, y: 0 },
  ...base,
  ...r,
});

describe('reelReleaseVerdict', () => {
  it('a long drag up is the next reel, down the previous', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-up', dy: -300 }))).toBe('next');
    expect(reelReleaseVerdict(release({ kind: 'swipe-down', dy: 300 }))).toBe('prev');
  });

  it('a short flick commits; a short slow drag springs back', () => {
    expect(
      reelReleaseVerdict(release({ kind: 'swipe-up', dy: -40, velocity: { x: 0, y: -1 } }))
    ).toBe('next');
    expect(
      reelReleaseVerdict(release({ kind: 'swipe-up', dy: -40, velocity: { x: 0, y: -0.05 } }))
    ).toBe('stay');
  });

  it('there is no next past the last reel, and no previous before the first', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-up', dy: -300, hasNext: false }))).toBe(
      'stay'
    );
    expect(reelReleaseVerdict(release({ kind: 'swipe-down', dy: 300, hasPrevious: false }))).toBe(
      'stay'
    );
  });

  it('a drag to the right closes, to the left does nothing', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: 200 }))).toBe('close');
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: -200 }))).toBe('stay');
  });

  it('a tap or a pinch is not a swipe', () => {
    expect(reelReleaseVerdict(release({ kind: 'pending', dy: -300 }))).toBe('stay');
    expect(reelReleaseVerdict(release({ kind: 'pinch', dy: -300 }))).toBe('stay');
  });
});

describe('reelDragOffset', () => {
  it('follows a vertical drag towards a neighbour, and resists past an end', () => {
    expect(reelDragOffset('swipe-up', 5, -100, true, true)).toEqual({ x: 0, y: -100, mediaX: 0 });
    expect(reelDragOffset('swipe-up', 5, -100, true, false).y).toBeCloseTo(-30);
  });

  it('moves right freely for the close and resists to the left', () => {
    expect(reelDragOffset('swipe-h', 100, 4, true, true)).toEqual({ x: 100, y: 0, mediaX: 0 });
    expect(reelDragOffset('swipe-h', -100, 4, true, true).x).toBeCloseTo(-30);
  });
});

describe('stepReelIndex', () => {
  it('moves by one and stops at both ends', () => {
    expect(stepReelIndex(0, 'next', 3)).toBe(1);
    expect(stepReelIndex(2, 'next', 3)).toBe(2);
    expect(stepReelIndex(0, 'prev', 3)).toBe(0);
    expect(stepReelIndex(1, 'stay', 3)).toBe(1);
    expect(stepReelIndex(1, 'close', 3)).toBe(1);
    expect(stepReelIndex(0, 'next', 0)).toBe(0);
  });
});

describe('mountedReelIndices', () => {
  it('mounts the previous, the current and the next (the preload)', () => {
    expect(mountedReelIndices(3, 10)).toEqual([2, 3, 4]);
  });

  it('stays inside the list at both ends', () => {
    expect(mountedReelIndices(0, 10)).toEqual([0, 1]);
    expect(mountedReelIndices(9, 10)).toEqual([8, 9]);
    expect(mountedReelIndices(0, 1)).toEqual([0]);
  });
});

describe('shouldLoadMoreReels', () => {
  it('asks for more two reels before the end, and only while there is more', () => {
    expect(shouldLoadMoreReels(5, 10, true)).toBe(false);
    expect(shouldLoadMoreReels(7, 10, true)).toBe(true);
    expect(shouldLoadMoreReels(9, 10, false)).toBe(false);
  });
});

describe('mergeReelPage', () => {
  it('keeps the touched reel first and never shows a reel twice', () => {
    expect(mergeReelPage([{ id: 'b' }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'b' },
      { id: 'a' },
      { id: 'c' },
    ]);
  });
});

describe('a carousel page (owner, 2026-11-06)', () => {
  const at = (index: number, count = 3) => ({ media: { index, count } });

  it('a long drag left is the next media, right the previous - never another post', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: -200, ...at(0) }))).toBe('media-next');
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: 200, ...at(1) }))).toBe('media-prev');
  });

  it('a flick commits, a short slow drag stays', () => {
    const flick = { x: -1, y: 0 };
    expect(
      reelReleaseVerdict(release({ kind: 'swipe-h', dx: -40, velocity: flick, ...at(0) }))
    ).toBe('media-next');
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: -40, ...at(0) }))).toBe('stay');
  });

  it('right on the first media still closes; left on the last springs back', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: 200, ...at(0) }))).toBe('close');
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: -200, ...at(2) }))).toBe('stay');
  });

  it('the vertical axis still pages posts, whatever media is visible', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-up', dy: -300, ...at(1) }))).toBe('next');
    expect(reelReleaseVerdict(release({ kind: 'swipe-down', dy: 300, ...at(1) }))).toBe('prev');
  });

  it('a page of one media keeps the old horizontal meaning', () => {
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: -200, ...at(0, 1) }))).toBe('stay');
    expect(reelReleaseVerdict(release({ kind: 'swipe-h', dx: 200, ...at(0, 1) }))).toBe('close');
  });

  it('a horizontal drag moves the strip, except the close on the first media', () => {
    expect(reelDragOffset('swipe-h', -50, 0, true, true, { index: 0, count: 3 })).toEqual({
      x: 0,
      y: 0,
      mediaX: -50,
    });
    expect(reelDragOffset('swipe-h', 50, 0, true, true, { index: 0, count: 3 })).toEqual({
      x: 50,
      y: 0,
      mediaX: 0,
    });
    // Past the last media: resistance, and the reel itself never moves.
    const past = reelDragOffset('swipe-h', -100, 0, true, true, { index: 2, count: 3 });
    expect(past.x).toBe(0);
    expect(past.mediaX).toBeGreaterThan(-100);
    expect(past.mediaX).toBeLessThan(0);
  });

  it('a vertical drag never moves the strip', () => {
    expect(reelDragOffset('swipe-up', 5, -80, true, true, { index: 1, count: 3 }).mediaX).toBe(0);
  });

  it('steps the media index inside its bounds, and only on a media verdict', () => {
    expect(stepMediaIndex(0, 'media-next', 3)).toBe(1);
    expect(stepMediaIndex(2, 'media-next', 3)).toBe(2);
    expect(stepMediaIndex(0, 'media-prev', 3)).toBe(0);
    expect(stepMediaIndex(1, 'next', 3)).toBe(1);
    expect(stepMediaIndex(4, 'media-prev', 1)).toBe(0);
  });

  it('only the visible media of the page on screen is active', () => {
    const page = { active: true, preload: false, settled: false, mediaIndex: 1 };
    expect(carouselMediaRole(1, page).active).toBe(true);
    expect(carouselMediaRole(0, page).active).toBe(false);
    expect(carouselMediaRole(2, page).active).toBe(false);
    const next = { active: false, preload: true, settled: true, mediaIndex: 0 };
    expect(carouselMediaRole(0, next).active).toBe(false);
  });

  it('draws the visible media and its neighbours, and fetches them only once it has settled', () => {
    const before = { active: true, preload: false, settled: false, mediaIndex: 1 };
    expect([0, 1, 2, 3].map((i) => carouselMediaRole(i, before).show)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect([0, 2].map((i) => carouselMediaRole(i, before).preload)).toEqual([false, false]);
    const after = { ...before, settled: true };
    expect([0, 1, 2, 3].map((i) => carouselMediaRole(i, after).preload)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('the next post preloads the media it opens on, and nothing else of it', () => {
    const next = { active: false, preload: true, settled: false, mediaIndex: 0 };
    expect([0, 1].map((i) => carouselMediaRole(i, next))).toEqual([
      { active: false, show: true, preload: true },
      { active: false, show: false, preload: false },
    ]);
    const far = { active: false, preload: false, settled: false, mediaIndex: 0 };
    expect(carouselMediaRole(0, far)).toEqual({ active: false, show: true, preload: false });
  });
});
