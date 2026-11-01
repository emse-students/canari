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
