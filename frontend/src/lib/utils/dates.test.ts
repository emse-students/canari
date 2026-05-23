import { describe, expect, it } from 'vitest';
import { formatTime24, isToday, isYesterday, readStoredTimestampMs, toValidDate } from './dates';

describe('readStoredTimestampMs', () => {
  it('parses numeric and string epoch ms from SQLite', () => {
    expect(readStoredTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(readStoredTimestampMs('1700000000000')).toBe(1_700_000_000_000);
  });

  it('returns undefined for invalid values', () => {
    expect(readStoredTimestampMs(null)).toBeUndefined();
    expect(readStoredTimestampMs('')).toBeUndefined();
  });
});

describe('toValidDate', () => {
  it('returns fallback for invalid Date', () => {
    const fallback = new Date('2020-06-15T12:00:00Z');
    expect(toValidDate(new Date('not-a-date'), fallback)).toEqual(fallback);
  });

  it('parses unix milliseconds', () => {
    const d = toValidDate(1_700_000_000_000);
    expect(d.getTime()).toBe(1_700_000_000_000);
  });
});

describe('formatTime24', () => {
  it('does not throw on invalid input', () => {
    expect(() => formatTime24(undefined)).not.toThrow();
  });

  it('formats hours and minutes with zero padding', () => {
    const d = new Date(2024, 2, 1, 9, 5);
    expect(formatTime24(d)).toBe('09:05');
  });
});

describe('isToday / isYesterday', () => {
  it('detects today', () => {
    expect(isToday(new Date())).toBe(true);
  });

  it('detects yesterday', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isYesterday(yesterday)).toBe(true);
  });
});
