import { clampWindowStart, resolveRenderWindow } from './renderWindow';

/**
 * WP-EMPTYVIEW-1. The defect these pin is not "the window is off by a few groups", it is a
 * conversation rendering ZERO messages while its store holds hundreds - so the assertions are
 * about the invariant (a non-empty list yields a non-empty window), not about exact indices.
 *
 * The numbers are ChatArea's own: 60 groups of entry window, 340 rendered at most.
 */
const INITIAL = 60;
const MAX = 340;

describe('clampWindowStart', () => {
  it('leaves a window that is valid for the current list untouched', () => {
    expect(clampWindowStart(640, 700, INITIAL)).toBe(640);
  });

  it('leaves a reader who paginated to the top at the top', () => {
    expect(clampWindowStart(0, 700, INITIAL)).toBe(0);
  });

  it('pulls a window back when the list is REPLACED by a shorter page', () => {
    // The exact shape of the bug: 700 groups in memory, entry window at 640, then a reload from
    // the local store replaces `messages` with a 50-group first page.
    expect(clampWindowStart(640, 50, INITIAL)).toBe(0);
  });

  it('keeps one screenful visible when the list shrinks to just over the entry window', () => {
    expect(clampWindowStart(640, 65, INITIAL)).toBe(5);
  });

  it('treats an emptied list as the top rather than a negative index', () => {
    expect(clampWindowStart(640, 0, INITIAL)).toBe(0);
  });

  it('never returns a negative or fractional index', () => {
    expect(clampWindowStart(-12, 700, INITIAL)).toBe(0);
    expect(clampWindowStart(Number.NaN, 700, INITIAL)).toBe(0);
    expect(clampWindowStart(12.7, 700, INITIAL)).toBe(12);
  });
});

describe('resolveRenderWindow', () => {
  it('renders the tail of a long conversation', () => {
    expect(resolveRenderWindow(640, 700, INITIAL, MAX)).toEqual({ start: 640, end: 700 });
  });

  it('renders everything there is when the list is shorter than the window', () => {
    expect(resolveRenderWindow(0, 12, INITIAL, MAX)).toEqual({ start: 0, end: 12 });
  });

  it('caps the number of rendered groups', () => {
    expect(resolveRenderWindow(0, 5000, INITIAL, MAX)).toEqual({ start: 0, end: MAX });
  });

  /**
   * The one that matters. Before the clamp this returned `{ start: 640, end: 50 }`, and
   * `slice(640, 50)` is `[]` - a conversation with 50 groups of messages rendering none of them.
   */
  it('NEVER yields an empty window for a non-empty list', () => {
    for (const groupCount of [1, 2, 7, 50, 59, 60, 61, 200, 700]) {
      for (const stored of [0, 1, 59, 60, 340, 639, 640, 5000]) {
        const { start, end } = resolveRenderWindow(stored, groupCount, INITIAL, MAX);
        expect(end).toBeGreaterThan(start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(groupCount);
      }
    }
  });

  it('yields an empty window only for a list that really is empty', () => {
    expect(resolveRenderWindow(0, 0, INITIAL, MAX)).toEqual({ start: 0, end: 0 });
  });
});
