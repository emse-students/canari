import { lastRowAbove, resolveAnchor, viewportBottom } from './visibleRow';

/** Rows 100px tall from y = 0, minus a scroll offset: `top(i) = i * 100 - scroll`. */
const tops = (scroll: number) => (i: number) => i * 100 - scroll;

describe('the bottom of what the reader sees', () => {
  it('stops above the floating composer, not at the scroller box', () => {
    expect(viewportBottom(600, 120)).toBe(480);
    expect(viewportBottom(600, Number.NaN)).toBe(600);
  });

  it('a row behind the composer band is not visible', () => {
    // 10 rows, scroller box bottom 600, composer 120: limit 480. Row 5 starts at 500 - hidden.
    const limit = viewportBottom(600, 120);
    expect(lastRowAbove(10, tops(0), limit)).toBe(4);
    // Measured against the box alone it would wrongly be visible.
    expect(lastRowAbove(10, tops(0), 600)).toBe(5);
  });
});

describe('the last row above the limit', () => {
  it('finds it by binary search, reading few rects', () => {
    const topOf = vi.fn(tops(0));
    expect(lastRowAbove(1000, topOf, 480)).toBe(4);
    expect(topOf.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('re-measures to a different row after the list changes under a still reader', () => {
    expect(lastRowAbove(10, tops(300), 480)).toBe(7);
    // Rows deleted below: the same viewport now reaches only the last row left.
    expect(lastRowAbove(5, tops(300), 480)).toBe(4);
  });

  it('is -1 when no row is above the limit, and tolerates rows outside the drawn window', () => {
    expect(lastRowAbove(0, tops(0), 480)).toBe(-1);
    expect(lastRowAbove(3, () => Infinity, 480)).toBe(-1);
    // Rows 0-1 above the window (-Infinity), 2-3 drawn, 4+ below (Infinity).
    const windowed = (i: number) => (i < 2 ? -Infinity : i < 4 ? (i - 2) * 100 : Infinity);
    expect(lastRowAbove(8, windowed, 480)).toBe(3);
  });
});

describe('a drawn row with no box of its own', () => {
  // The Mi 9T ending (2026-11-25): ten rows, the thread pinned at its end - a voice note then two
  // 738 px images - so every top is above the limit. Row 4 is a system line that had no id (the first probe at n=10).
  const pinned = (boxless: ReadonlySet<number>) => (i: number) =>
    boxless.has(i) ? null : i < 7 ? -4000 + i * 100 : -738 * (10 - i) + 400;

  it('does not hide the rows after it: the newest row is found', () => {
    const met: number[] = [];
    expect(lastRowAbove(10, pinned(new Set([4])), 480, (i) => met.push(i))).toBe(9);
    expect(met).toEqual([4]);
  });

  it('is the production n=10 case: a boxless row read as Infinity hid the newest row', () => {
    // Mi 9T DOM: row 4 is the "added a device" line. The old accessor answered Infinity for it, so
    // the first probe (4) sent the search left and it ended on row 3.
    const asBefore = (i: number) => (i === 4 ? Infinity : pinned(new Set())(i));
    expect(lastRowAbove(10, asBefore, 480)).toBe(3);
    expect(lastRowAbove(10, pinned(new Set([4])), 480)).toBe(9);
  });

  it('whichever probe it lands on', () => {
    for (const i of [4, 7, 8]) {
      expect(lastRowAbove(10, pinned(new Set([i])), 480)).toBe(9);
    }
  });

  it('answers with a row that has a box, and from the left when none is left on the right', () => {
    expect(lastRowAbove(10, pinned(new Set([9])), 480)).toBe(8);
    expect(lastRowAbove(3, () => null, 480)).toBe(-1);
  });

  it('stands aside for a reader in the middle of the thread', () => {
    // Rows 0-3 above the limit, row 4 boxless, rows 5-9 below: the last visible is row 3.
    const mid = (i: number) => (i === 4 ? null : i < 4 ? i * 100 : 600 + i * 100);
    expect(lastRowAbove(10, mid, 480)).toBe(3);
  });
});

describe('resolving the anchor against the thread now', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('keeps an anchor still in place', () => {
    expect(resolveAnchor(ids, { id: 'c', index: 2 })).toEqual({ index: 2, exact: true });
  });

  it('finds a moved anchor by id', () => {
    expect(resolveAnchor(['z', ...ids], { id: 'c', index: 2 })).toEqual({ index: 3, exact: true });
  });

  it('falls back on the nearest surviving row, flagged inexact, when the id is gone', () => {
    expect(resolveAnchor(['a', 'b', 'd'], { id: 'c', index: 2 })).toEqual({
      index: 2,
      exact: false,
    });
    expect(resolveAnchor(['a', 'b'], { id: 'c', index: 2 })).toEqual({ index: 1, exact: false });
  });

  it('has no position for no anchor (a conversation switch resets to null) or an empty thread', () => {
    expect(resolveAnchor(ids, null).index).toBe(-1);
    expect(resolveAnchor([], { id: 'c', index: 2 }).index).toBe(-1);
  });
});
