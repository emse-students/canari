import { describe, expect, it } from 'vitest';
import { formatDateSafe, toValidDate } from './dates';

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

describe('formatDateSafe', () => {
  it('does not throw on invalid input', () => {
    expect(() => formatDateSafe(undefined, 'HH:mm')).not.toThrow();
  });
});
