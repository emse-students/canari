import { describe, expect, it } from 'vitest';
import { bucketOf, groupNotifications, NOTIFICATION_BUCKETS } from './grouping';
import type { PostNotification } from '$lib/posts/api';

/** The reference instant every case is measured against - never `new Date()`. */
const NOW = new Date(2026, 8, 8, 14, 30, 0); // 2026-09-08 14:30 local

function notif(id: string, createdAt: Date | string): PostNotification {
  return {
    id,
    type: 'comment',
    postId: 'p1',
    actorId: 'u1',
    actorName: 'A',
    text: '',
    read: true,
    createdAt: typeof createdAt === 'string' ? createdAt : createdAt.toISOString(),
  };
}

describe('bucketOf', () => {
  it('puts anything in the unread snapshot in `new`, however old it is', () => {
    const old = notif('n1', new Date(2020, 0, 1));
    expect(bucketOf(old, new Set(['n1']), NOW)).toBe('new');
  });

  it('uses the calendar day, not the last 24 hours', () => {
    // 23:50 yesterday is 14h40 ago, well inside 24 hours, and is still not "today".
    expect(bucketOf(notif('n', new Date(2026, 8, 7, 23, 50)), new Set(), NOW)).toBe('week');
    // 00:10 today is 14h20 ago and IS today.
    expect(bucketOf(notif('n', new Date(2026, 8, 8, 0, 10)), new Set(), NOW)).toBe('today');
  });

  it('counts `week` in whole days from the start of today, inclusive of the sixth', () => {
    expect(bucketOf(notif('n', new Date(2026, 8, 2, 0, 0)), new Set(), NOW)).toBe('week');
    expect(bucketOf(notif('n', new Date(2026, 8, 1, 23, 59)), new Set(), NOW)).toBe('earlier');
  });

  it('treats an unparseable date as earlier rather than throwing', () => {
    expect(bucketOf(notif('n', 'not-a-date'), new Set(), NOW)).toBe('earlier');
  });
});

describe('groupNotifications', () => {
  it('returns the bands in a fixed order and drops the empty ones', () => {
    const list = [
      notif('a', new Date(2026, 8, 8, 9, 0)), // today
      notif('b', new Date(2020, 0, 1)), // earlier
      notif('c', new Date(2026, 8, 8, 8, 0)), // today
    ];
    expect(groupNotifications(list, new Set(), NOW).map((g) => g.bucket)).toEqual([
      'today',
      'earlier',
    ]);
  });

  it('preserves the input order inside a band rather than re-sorting', () => {
    const list = [notif('a', new Date(2026, 8, 8, 8, 0)), notif('b', new Date(2026, 8, 8, 9, 0))];
    const [today] = groupNotifications(list, new Set(), NOW);
    expect(today.items.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('routes the snapshot into `new` and leaves the same row out of its age band', () => {
    const list = [notif('a', new Date(2026, 8, 8, 9, 0)), notif('b', new Date(2026, 8, 8, 9, 0))];
    const groups = groupNotifications(list, new Set(['a']), NOW);
    expect(groups.map((g) => g.bucket)).toEqual(['new', 'today']);
    expect(groups[0].items.map((n) => n.id)).toEqual(['a']);
    expect(groups[1].items.map((n) => n.id)).toEqual(['b']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupNotifications([], new Set(), NOW)).toEqual([]);
  });

  it('never emits a bucket outside the declared order', () => {
    const list = [notif('a', new Date(2026, 8, 8, 9, 0)), notif('b', new Date(2020, 0, 1))];
    for (const g of groupNotifications(list, new Set(['a']), NOW)) {
      expect(NOTIFICATION_BUCKETS).toContain(g.bucket);
    }
  });
});
