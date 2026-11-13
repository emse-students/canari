import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchBirthdaysToday } = vi.hoisted(() => ({ fetchBirthdaysToday: vi.fn() }));
vi.mock('./api', () => ({ fetchBirthdaysToday, fetchMyBirthday: vi.fn() }));

import { BirthdaysTodayStore, parisDate } from './birthdaysToday.svelte';

describe('parisDate', () => {
  it('reads the Paris calendar day, not the UTC one', () => {
    // 23:30 UTC on the 9th is already the 10th in Paris (winter, UTC+1).
    expect(parisDate(Date.parse('2026-11-09T23:30:00Z'))).toBe('2026-11-10');
    expect(parisDate(Date.parse('2026-11-10T12:00:00Z'))).toBe('2026-11-10');
  });
});

describe('BirthdaysTodayStore asks once per Paris day', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    fetchBirthdaysToday.mockReset();
    fetchBirthdaysToday.mockResolvedValue({ date: '2026-11-10', userIds: ['u1'] });
  });
  afterEach(() => vi.useRealTimers());

  it('does not ask again for the same account on the same day', async () => {
    const store = new BirthdaysTodayStore();
    await store.refresh('me');
    await store.refresh('me');
    await store.refresh('me');
    expect(fetchBirthdaysToday).toHaveBeenCalledTimes(1);
    expect(store.has('u1')).toBe(true);
  });

  it('asks again on a new day', async () => {
    const store = new BirthdaysTodayStore();
    await store.refresh('me');
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    fetchBirthdaysToday.mockResolvedValue({ date: '2026-11-11', userIds: [] });
    await store.refresh('me');
    expect(fetchBirthdaysToday).toHaveBeenCalledTimes(2);
    expect(store.has('u1')).toBe(false);
  });

  it('asks again for another account, and after an invalidate', async () => {
    const store = new BirthdaysTodayStore();
    await store.refresh('me');
    await store.refresh('other');
    expect(fetchBirthdaysToday).toHaveBeenCalledTimes(2);
    store.invalidate();
    await store.refresh('other');
    expect(fetchBirthdaysToday).toHaveBeenCalledTimes(3);
  });

  it('a failed ask is asked again, never cached', async () => {
    const store = new BirthdaysTodayStore();
    fetchBirthdaysToday.mockRejectedValueOnce(new Error('offline'));
    await store.refresh('me');
    await store.refresh('me');
    expect(fetchBirthdaysToday).toHaveBeenCalledTimes(2);
  });
});
