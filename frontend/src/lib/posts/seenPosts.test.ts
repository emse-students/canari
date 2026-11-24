import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEEN_POSTS_MAX,
  TREND_CONTENT_KEYS,
  TREND_PRUNE_GRACE_MS,
  TREND_WINDOW_HOURS,
  isSeenTrend,
  noteSeen,
  parseSeen,
  pruneSeen,
  serializeSeen,
  type SeenPosts,
} from './seenPosts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** The contract every platform's reader follows (`libs/contracts/notification-seen-trend.cases.json`). */
const contract = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'libs',
      'contracts',
      'notification-seen-trend.cases.json'
    ),
    'utf8'
  )
) as {
  trendWindowHours: number;
  trendKeys: string[];
  book: { userId: string; posts: Record<string, number> };
  cases: {
    name: string;
    me: string | null;
    contentKey: string | null;
    postId: string;
    expected: boolean;
  }[];
};

describe('the seen-posts record: what counts and how it is pruned', () => {
  it('notes a post once, under its lower-cased id', () => {
    const seen: SeenPosts = new Map();
    expect(noteSeen(seen, ' ABC-1 ', NOW)).toBe(true);
    expect(noteSeen(seen, 'abc-1', NOW + 5)).toBe(false);
    expect([...seen]).toEqual([['abc-1', NOW]]);
  });

  it('refuses an empty id and an instant that is not a number', () => {
    const seen: SeenPosts = new Map();
    expect(noteSeen(seen, '  ', NOW)).toBe(false);
    expect(noteSeen(seen, 'p', Number.NaN)).toBe(false);
    expect(seen.size).toBe(0);
  });

  it('prunes a post only on what the bell proved: an answer past its window that reaches back before it', () => {
    const entries: [string, number][] = [
      ['fresh', NOW - 1 * HOUR],
      ['edge', NOW - TREND_WINDOW_HOURS * HOUR],
      ['inside-grace', NOW - TREND_WINDOW_HOURS * HOUR - TREND_PRUNE_GRACE_MS + 1],
      ['too-old', NOW - TREND_WINDOW_HOURS * HOUR - TREND_PRUNE_GRACE_MS - 1],
    ];
    // A page that listed EVERY row (coveredFrom 0): the age alone decides, never before the window.
    const full: SeenPosts = new Map(entries);
    expect(pruneSeen(full, { answeredAt: NOW, coveredFrom: 0 })).toEqual({ aged: 1, capped: 0 });
    expect([...full.keys()].sort()).toEqual(['edge', 'fresh', 'inside-grace']);
    // No answer yet, or none past the window: nothing is pruned by age.
    const none: SeenPosts = new Map(entries);
    expect(pruneSeen(none, null)).toEqual({ aged: 0, capped: 0 });
    expect(pruneSeen(none, { answeredAt: 0, coveredFrom: 0 })).toEqual({ aged: 0, capped: 0 });
    expect(none.size).toBe(4);
  });

  it('keeps a post the answer did not reach back to, and drops the ones it did', () => {
    const seen: SeenPosts = new Map([
      ['older', NOW - 60 * HOUR],
      ['newer', NOW - 40 * HOUR],
    ]);
    // A full page of rows whose oldest is 50 h old: it covers `newer` (published later) but not `older`.
    const out = pruneSeen(seen, { answeredAt: NOW, coveredFrom: NOW - 50 * HOUR });
    expect(out).toEqual({ aged: 1, capped: 0 });
    expect([...seen.keys()]).toEqual(['older']);
  });

  it('caps the record and drops the OLDEST publications first', () => {
    const seen: SeenPosts = new Map();
    for (let i = 0; i < SEEN_POSTS_MAX + 3; i++) seen.set(`p${i}`, NOW - 1000 + i);
    const out = pruneSeen(seen, null);
    expect(out).toEqual({ aged: 0, capped: 3 });
    expect(seen.has('p0')).toBe(false);
    expect(seen.has('p2')).toBe(false);
    expect(seen.has('p3')).toBe(true);
    expect(seen.size).toBe(SEEN_POSTS_MAX);
  });

  it('round-trips through the sealed body and refuses a body of another shape', () => {
    const seen: SeenPosts = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    expect(parseSeen(serializeSeen(seen))).toEqual(seen);
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen({ posts: [] })).toBeNull();
    expect(parseSeen({ posts: { a: 'x' } })).toBeNull();
    expect(parseSeen({ items: [] })).toBeNull();
  });
});

describe('a campus trend is classified on its field, never its text', () => {
  const seen: SeenPosts = new Map([['p1', NOW]]);

  it('a bell row of type campus_trend for a displayed post is withheld', () => {
    expect(isSeenTrend(seen, { type: 'campus_trend' }, 'p1')).toBe(true);
    expect(isSeenTrend(seen, { type: 'campus_trend' }, ' P1 ')).toBe(true);
  });

  it('a push of a trend key for a displayed post is withheld', () => {
    for (const contentKey of TREND_CONTENT_KEYS) {
      expect(isSeenTrend(seen, { contentKey }, 'p1')).toBe(true);
    }
  });

  it('shows what is not a trend, or not a displayed post', () => {
    expect(isSeenTrend(seen, { type: 'campus_trend' }, 'p2')).toBe(false);
    expect(isSeenTrend(seen, { type: 'campus_trend' }, null)).toBe(false);
    expect(isSeenTrend(seen, { type: 'friend_comment' }, 'p1')).toBe(false);
    expect(isSeenTrend(seen, { contentKey: 'social_comment' }, 'p1')).toBe(false);
    // The wording is never a classifier.
    expect(isSeenTrend(seen, { contentKey: 'Suggestion : campus_trend' }, 'p1')).toBe(false);
  });

  it('holds the same trend keys and window as the shared contract', () => {
    expect([...TREND_CONTENT_KEYS]).toEqual(contract.trendKeys);
    expect(TREND_WINDOW_HOURS).toBe(contract.trendWindowHours);
  });

  it('follows the shared contract cases (a push, for the signed-in account)', () => {
    const book: SeenPosts = new Map(Object.entries(contract.book.posts));
    expect(contract.cases.length).toBeGreaterThan(10);
    for (const c of contract.cases) {
      // The client holds one account's record in memory, so another account's case is "no record".
      const mine = c.me !== null && c.me === contract.book.userId;
      const got = mine && isSeenTrend(book, { contentKey: c.contentKey }, c.postId);
      expect(got, c.name).toBe(c.expected);
    }
  });
});
