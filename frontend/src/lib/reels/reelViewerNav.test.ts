/**
 * The viewer's navigation, decided by numbers and never by a clock: what a released drag means,
 * where it leads, what stays mounted, when the next page is asked for.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeReelPage,
  mountedReelIndices,
  reelDragOffset,
  reelReleaseVerdict,
  shouldLoadMoreReels,
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
    expect(reelDragOffset('swipe-up', 5, -100, true, true)).toEqual({ x: 0, y: -100 });
    expect(reelDragOffset('swipe-up', 5, -100, true, false).y).toBeCloseTo(-30);
  });

  it('moves right freely for the close and resists to the left', () => {
    expect(reelDragOffset('swipe-h', 100, 4, true, true)).toEqual({ x: 100, y: 0 });
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
