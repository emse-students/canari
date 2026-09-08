import { clampWindowStart, resolveRenderWindow, stepWindowOlder } from './renderWindow';

/**
 * WP-EMPTYVIEW-1. The defect these pin is not "the window is off by a few groups", it is a
 * conversation rendering ZERO messages while its store holds hundreds - so the assertions are
 * about the invariant (a non-empty list yields a non-empty window), not about exact indices.
 *
 * The numbers are ChatArea's own: 60 groups of entry window, 340 rendered at most.
 */
const INITIAL = 60;

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
    expect(resolveRenderWindow(640, 700, INITIAL)).toEqual({ start: 640, end: 700 });
  });

  it('renders everything there is when the list is shorter than the window', () => {
    expect(resolveRenderWindow(0, 12, INITIAL)).toEqual({ start: 0, end: 12 });
  });

  it('does NOT cap the rendered groups - the cap is what made the end slide', () => {
    // 5000 groups only get here because a reader paginated through them one page at a time; the
    // bound that matters is their scrolling, not an arithmetic ceiling that drops the present.
    expect(resolveRenderWindow(0, 5000, INITIAL)).toEqual({ start: 0, end: 5000 });
  });

  /**
   * The one that matters. Before the clamp this returned `{ start: 640, end: 50 }`, and
   * `slice(640, 50)` is `[]` - a conversation with 50 groups of messages rendering none of them.
   */
  it('NEVER yields an empty window for a non-empty list', () => {
    for (const groupCount of [1, 2, 7, 50, 59, 60, 61, 200, 700]) {
      for (const stored of [0, 1, 59, 60, 340, 639, 640, 5000]) {
        const { start, end } = resolveRenderWindow(stored, groupCount, INITIAL);
        expect(end).toBeGreaterThan(start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(groupCount);
      }
    }
  });

  it('yields an empty window only for a list that really is empty', () => {
    expect(resolveRenderWindow(0, 0, INITIAL)).toEqual({ start: 0, end: 0 });
  });
});

/**
 * THE WINDOW IS ANCHORED TO THE NEWEST MESSAGE AND ONLY GROWS.
 *
 * It used to be `start + MAX` wide and to SLIDE, so paginating upwards walked the end up too: past
 * 340 groups the newest messages left the DOM, scrolling down could not bring them back, and
 * `scrollHeight` - the height of the rendered slice - changed size under a reader who had changed
 * nothing. Reported by a user 2026-09-09, first as "the recent messages disappear", then, exactly,
 * as "the scrollbar becomes wrong if recent messages disappear". These pin the property that makes
 * all three impossible rather than the arithmetic that used to bound them.
 */
const STEP = 140;

describe('the window is anchored to the newest message', () => {
  it('always ends at the end of the list, however far back the reader has paginated', () => {
    for (const start of [640, 500, 360, 220, 80, 0]) {
      expect(resolveRenderWindow(start, 700, INITIAL).end).toBe(700);
    }
  });

  it('grows monotonically as the reader walks upwards - it never gives width back', () => {
    let start = clampWindowStart(640, 700, INITIAL);
    let width = resolveRenderWindow(start, 700, INITIAL).end - start;
    for (let i = 0; i < 6; i++) {
      start = stepWindowOlder(start, STEP);
      const next = resolveRenderWindow(start, 700, INITIAL);
      expect(next.end).toBe(700);
      expect(next.end - next.start).toBeGreaterThanOrEqual(width);
      width = next.end - next.start;
    }
    expect(start).toBe(0);
  });

  it('renders the whole conversation once the reader has walked to the top', () => {
    expect(resolveRenderWindow(0, 700, INITIAL)).toEqual({ start: 0, end: 700 });
  });

  it('never steps the window before the top', () => {
    expect(stepWindowOlder(100, STEP)).toBe(0);
    expect(stepWindowOlder(0, STEP)).toBe(0);
  });

  it('refuses a zero step, which would make pagination a no-op loop', () => {
    expect(stepWindowOlder(10, 0)).toBe(9);
  });
});
