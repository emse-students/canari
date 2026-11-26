// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEDIA_CACHE_CAP_BYTES,
  MEDIA_CACHE_CAP_CHOICES,
  SERVER_HOLD_WINDOW_MS,
  planEviction,
  readMediaCacheCap,
  writeMediaCacheCap,
  type LedgerRecord,
} from './mediaCacheCap';

const MB = 1024 * 1024;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A copy the server confirmed `confirmedDaysAgo` days ago (null: never), used `usedDaysAgo` ago. */
function copy(mb: number, usedDaysAgo: number, confirmedDaysAgo: number | null): LedgerRecord {
  return {
    bytes: mb * MB,
    lastUsed: NOW - usedDaysAgo * DAY,
    confirmedAt: confirmedDaysAgo === null ? 0 : NOW - confirmedDaysAgo * DAY,
  };
}

describe('planEviction', () => {
  it('plans nothing under the cap, and nothing when the cap is unlimited', () => {
    const records = new Map([['a', copy(100, 1, 1)]]);
    expect(planEviction(records, 500 * MB, NOW).evict).toEqual([]);
    expect(planEviction(records, null, NOW).evict).toEqual([]);
  });

  it('fills the cap and evicts least recently used first, only as many as needed', () => {
    const records = new Map([
      ['newest', copy(200, 1, 1)],
      ['oldest', copy(200, 20, 2)],
      ['middle', copy(200, 10, 1)],
    ]);
    // 600 MB in a 500 MB cap: the oldest alone frees enough.
    expect(planEviction(records, 500 * MB, NOW).evict).toEqual(['oldest']);
    // 600 MB in a 250 MB cap: two go, oldest then middle.
    const plan = planEviction(records, 250 * MB, NOW);
    expect(plan.evict).toEqual(['oldest', 'middle']);
    expect(plan.totalBytes).toBe(600 * MB);
    expect(plan.overCapBytes).toBe(0);
  });

  it('never evicts a sole copy, however old, and says how far over the cap it stays', () => {
    const records = new Map([
      ['never-confirmed', copy(300, 90, null)],
      ['confirmed-long-ago', copy(300, 80, 60)],
      ['confirmed-lately', copy(100, 5, 2)],
    ]);
    const plan = planEviction(records, 250 * MB, NOW);
    // The two oldest are possibly the only copy left: only the recent confirmation may go.
    expect(plan.evict).toEqual(['confirmed-lately']);
    expect(plan.keptSole).toBe(2);
    expect(plan.overCapBytes).toBe(350 * MB);
  });

  it('a confirmation stops counting once it is older than the hold window', () => {
    const days = SERVER_HOLD_WINDOW_MS / DAY;
    const records = new Map([
      ['inside', copy(300, 5, days - 1)],
      ['outside', copy(300, 6, days + 1)],
    ]);
    expect(planEviction(records, 250 * MB, NOW).evict).toEqual(['inside']);
  });
});

describe('the member cap', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('is 500 MB until the member chooses, and offers 250 MB, 500 MB, 1 GB and unlimited', () => {
    expect(readMediaCacheCap()).toBe(DEFAULT_MEDIA_CACHE_CAP_BYTES);
    expect(DEFAULT_MEDIA_CACHE_CAP_BYTES).toBe(500 * MB);
    expect(MEDIA_CACHE_CAP_CHOICES).toEqual([250 * MB, 500 * MB, 1024 * MB, null]);
  });

  it('round-trips every choice, unlimited included', () => {
    for (const choice of MEDIA_CACHE_CAP_CHOICES) {
      writeMediaCacheCap(choice);
      expect(readMediaCacheCap()).toBe(choice);
    }
  });

  it('ignores a stored value that is not an offered choice, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('canari-media-cache-cap', '12345');
    expect(readMediaCacheCap()).toBe(DEFAULT_MEDIA_CACHE_CAP_BYTES);
    expect(warn).toHaveBeenCalled();
  });
});
