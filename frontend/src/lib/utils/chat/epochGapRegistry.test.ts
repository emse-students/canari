import { describe, it, expect, beforeEach } from 'vitest';
import {
  markEpochGap,
  clearEpochGap,
  isInEpochGap,
  anyEpochGapArmed,
  stuckEpochGaps,
  resetEpochGapRegistry,
} from './epochGapRegistry';

/**
 * The registry is the set of groups owed an escalation, and until now nothing could ASK it that.
 * Its only escalator iterated a list built for re-adds - conversations plus the not-ready registry -
 * so a group in neither went in and never came out. {@link stuckEpochGaps} is what makes the set
 * readable by the thing that acts on it.
 */
describe('stuckEpochGaps', () => {
  beforeEach(() => resetEpochGapRegistry());

  it('names only the gaps older than the threshold', () => {
    markEpochGap('g');
    // NEVER ASSERT A WALL CLOCK: the marks are stamped with the real `Date.now()`, so the reading
    // moves instead - once from far enough ahead to be stuck, once from the instant they were made.
    expect(stuckEpochGaps(45_000, Date.now() + 46_000)).toEqual(['g']);
    expect(stuckEpochGaps(45_000, Date.now())).toEqual([]);
  });

  it('returns the oldest first, so one throwing entry does not starve the others', () => {
    markEpochGap('first');
    markEpochGap('second');
    expect(stuckEpochGaps(0, Date.now() + 1)).toEqual(['first', 'second']);
  });

  it('is empty once the marks are cleared, which is what lets the tick go quiet again', () => {
    markEpochGap('g');
    expect(anyEpochGapArmed()).toBe(true);
    expect(isInEpochGap('g')).toBe(true);
    clearEpochGap('g');
    expect(stuckEpochGaps(0, Date.now() + 1)).toEqual([]);
    expect(anyEpochGapArmed()).toBe(false);
  });

  it('keeps the FIRST timestamp when a group is marked again, so the wait is not restarted', () => {
    const first = markEpochGap('g');
    expect(markEpochGap('g')).toBe(first);
  });
});
