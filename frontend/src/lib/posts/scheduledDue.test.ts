import { describe, expect, it } from 'vitest';
import { MAX_TIMER_MS, applyScheduledEdit, msUntilNextDue, stillScheduled } from './scheduledDue';

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

describe('a post that is not scheduled', () => {
  it('has no due time and is not kept', () => {
    expect(msUntilNextDue([{ scheduledAt: null }, {}], 1000)).toBeNull();
    expect(stillScheduled([{ scheduledAt: null }], 1000)).toEqual([]);
  });
});

describe('applyScheduledEdit', () => {
  const p = (id: string, ms: number | null) => ({
    id,
    scheduledAt: ms === null ? null : new Date(ms).toISOString(),
  });
  it('replaces the row and re-sorts when the post is still in the future', () => {
    const out = applyScheduledEdit([p('a', 2000), p('b', 3000)], p('a', 4000), 1000);
    expect(out.published).toBe(false);
    expect(out.posts.map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('drops the post and asks for a feed re-read when the edit publishes it now', () => {
    const out = applyScheduledEdit([p('a', 2000), p('b', 3000)], p('a', 900), 1000);
    expect(out).toEqual({ posts: [p('b', 3000)], published: true });
  });
  it('drops the post when the edit removes its schedule', () => {
    expect(applyScheduledEdit([p('a', 2000)], p('a', null), 1000).published).toBe(true);
  });
});
