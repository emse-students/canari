import {
  clampWindowStart,
  entryWindowStart,
  resolveRenderWindow,
  stepWindowOlder,
  widenedEntryStart,
  fillStart,
  widenStepStart,
} from './renderWindow';

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

describe('entry window - the first frame mounts the viewport tail only', () => {
  it('opens on the last N groups of a 56-row page, not on the whole entry window', () => {
    const start = entryWindowStart(56, 20);
    const w = resolveRenderWindow(start, 56, 20);
    expect(w.end - w.start).toBe(20);
  });

  it('is not clamped back to the wider entry window by the read side', () => {
    // resolveRenderWindow clamps against the size it is given: passing the FULL size would pull a
    // 20-group first frame back to 60 groups, which is the long task this exists to avoid.
    expect(resolveRenderWindow(36, 56, 60).end - resolveRenderWindow(36, 56, 60).start).toBe(56);
    expect(resolveRenderWindow(36, 56, 20).end - resolveRenderWindow(36, 56, 20).start).toBe(20);
  });

  it('shows everything of a list shorter than the first frame', () => {
    expect(entryWindowStart(7, 20)).toBe(0);
  });

  it('widens to the full entry size after the first frame', () => {
    expect(widenedEntryStart(36, 56, 60)).toBe(0);
    expect(widenedEntryStart(180, 200, 60)).toBe(140);
  });

  it('never narrows a window the reader already widened, and has nothing to do when full', () => {
    expect(widenedEntryStart(10, 200, 60)).toBeNull();
    expect(widenedEntryStart(0, 56, 60)).toBeNull();
    expect(widenedEntryStart(140, 200, 60)).toBeNull();
  });
});

describe('fillStart - the rows a short first frame is missing, by its own measure', () => {
  it('asks for the deficit divided by the measured row height, with a floor', () => {
    // 20 rows of 36 px = 720 in a 700 pane that must overflow by 40: 20 px short -> the floor.
    expect(fillStart(36, 20, 720, 700, 40, 4, 0)).toBe(32);
    // 20 rows of 20 px = 400: 340 px short = 17 rows.
    expect(fillStart(36, 20, 400, 700, 40, 4, 0)).toBe(19);
  });

  it('is null when the pane already overflows or nothing is hidden', () => {
    expect(fillStart(36, 20, 960, 700, 40, 4, 0)).toBeNull();
    expect(fillStart(0, 20, 400, 700, 40, 4, 0)).toBeNull();
  });

  it('never mounts more than the full entry window on a measure alone, and never past the list', () => {
    // 20 rows of 2 px: 350 rows wanted, capped at the entry start (140 of a 200 list = 60 rows).
    expect(fillStart(180, 20, 40, 700, 40, 4, 140)).toBe(140);
    // A window already past the entry start pages by the measure instead.
    expect(fillStart(100, 60, 600, 700, 40, 4, 140)).toBe(86);
    expect(fillStart(3, 20, 100, 700, 40, 4, 0)).toBe(0);
  });
});

describe('widenStepStart - the widen after the reveal, a few groups per task', () => {
  it('steps towards the target and stops on it', () => {
    expect(widenStepStart(140, 100, 10)).toBe(130);
    expect(widenStepStart(104, 100, 10)).toBe(100);
    expect(widenStepStart(100, 100, 10)).toBeNull();
    expect(widenStepStart(50, 100, 10)).toBeNull();
  });
});
