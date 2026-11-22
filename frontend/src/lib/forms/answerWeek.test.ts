/**
 * An anonymous form's answer is shown by its WEEK (owner, 2026-11-22): the Monday that starts it,
 * read on the UTC wall clock the server writes, never the day the value names.
 */
import { describe, it, expect } from 'vitest';
import { anonymousAnswerWeekStart, formatAnonymousAnswerWeek } from './answerWeek';
import { m } from '$lib/paraglide/messages';

describe('anonymousAnswerWeekStart', () => {
  it('takes every day of an ISO week, Monday to Sunday, to its Monday 00:00 UTC', () => {
    // 2026-11-16 is a Monday; 2026-11-22 the Sunday that ends its week.
    for (let day = 16; day <= 22; day++) {
      const iso = `2026-11-${day}T${day === 22 ? '23:59:59' : '08:30:00'}.000Z`;
      expect(anonymousAnswerWeekStart(iso).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    }
  });

  it('keeps a week start as it is, and opens a new week on the next Monday', () => {
    expect(anonymousAnswerWeekStart('2026-11-16T00:00:00.000Z').toISOString()).toBe(
      '2026-11-16T00:00:00.000Z'
    );
    expect(anonymousAnswerWeekStart('2026-11-23T00:00:00.000Z').toISOString()).toBe(
      '2026-11-23T00:00:00.000Z'
    );
  });

  it('crosses a month and a year boundary', () => {
    // 2027-01-01 is a Friday: its week began on Monday 2026-12-28.
    expect(anonymousAnswerWeekStart('2027-01-01T12:00:00.000Z').toISOString()).toBe(
      '2026-12-28T00:00:00.000Z'
    );
  });
});

describe('formatAnonymousAnswerWeek', () => {
  it('names the week by its Monday, never by the day the value holds', () => {
    const text = formatAnonymousAnswerWeek('2026-11-19T00:00:00.000Z');
    expect(text).toBe(m.form_answer_week_of({ date: text.match(/\d+.*$/)![0] }));
    expect(text).toMatch(/\b16\b/);
    expect(text).not.toMatch(/\b19\b/);
    // No time of day either: it was never stored.
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });
});
