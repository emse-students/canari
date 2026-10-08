import { describe, expect, it } from 'vitest';
import { MAX_TIMER_MS, msUntilNextDue, stillScheduled } from './scheduledDue';

const at = (ms: number) => ({ scheduledAt: new Date(ms).toISOString() });

describe('msUntilNextDue', () => {
  it('is null with nothing scheduled', () => {
    expect(msUntilNextDue([], 1000)).toBeNull();
  });
  it('waits for the EARLIEST post, whatever the list order', () => {
    expect(msUntilNextDue([at(9000), at(5000), at(7000)], 1000)).toBe(4000);
  });
  it('is zero for an overdue post, never negative', () => {
    expect(msUntilNextDue([at(500)], 1000)).toBe(0);
  });
  it('caps a far-future wait at the timer limit', () => {
    expect(msUntilNextDue([at(1000 + MAX_TIMER_MS * 3)], 1000)).toBe(MAX_TIMER_MS);
  });
  it('ignores an unparseable timestamp', () => {
    expect(msUntilNextDue([{ scheduledAt: 'nope' }, at(3000)], 1000)).toBe(2000);
  });
});

describe('stillScheduled', () => {
  it('drops the posts whose time has come, keeps the future ones', () => {
    const kept = stillScheduled([at(900), at(1000), at(1001)], 1000);
    expect(kept).toEqual([at(1001)]);
  });
});
