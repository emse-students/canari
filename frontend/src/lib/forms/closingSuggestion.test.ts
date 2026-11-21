import { describe, expect, it } from 'vitest';
import {
  CLOSING_SUGGESTION_DAYS,
  closingSuggestionKind,
  suggestClosingDate,
} from './closingSuggestion';

/** A local wall time, so the assertions hold in whatever zone the suite runs in. */
const at = (y: number, mo: number, d: number, h = 10) => new Date(y, mo - 1, d, h, 0);
const NOW = at(2026, 11, 21);

describe('the closing date suggested at publication', () => {
  it('offers 14 days to a free ordinary form, ending at 23:59', () => {
    expect(suggestClosingDate({}, { opensAt: '', closedAt: '' }, NOW)).toEqual({
      kind: 'standard',
      days: 14,
      value: '2026-12-05T23:59',
    });
  });

  it('offers 7 days to a capped form and to an anonymous one (a poll)', () => {
    expect(closingSuggestionKind({ maxSubmissions: 30 })).toBe('quick');
    expect(closingSuggestionKind({ anonymous: true })).toBe('quick');
    expect(suggestClosingDate({ anonymous: true }, { opensAt: '', closedAt: '' }, NOW)?.value).toBe(
      '2026-11-28T23:59'
    );
  });

  it('offers 21 days to a form that charges, whatever else it is', () => {
    expect(closingSuggestionKind({ requiresPayment: true, maxSubmissions: 30 })).toBe('paid');
    expect(closingSuggestionKind({ basePrice: 500, anonymous: true })).toBe('paid');
    expect(
      closingSuggestionKind({
        items: [{ type: 'single_choice', options: [{ priceModifier: 300 }] }],
      })
    ).toBe('paid');
    expect(
      suggestClosingDate({ requiresPayment: true }, { opensAt: '', closedAt: '' }, NOW)?.value
    ).toBe('2026-12-12T23:59');
  });

  it('matches the server window for the paid kind: a suggestion never closes before the form is asked about', () => {
    expect(CLOSING_SUGGESTION_DAYS.paid).toBe(21);
    expect(CLOSING_SUGGESTION_DAYS.quick).toBeLessThan(CLOSING_SUGGESTION_DAYS.standard);
    expect(CLOSING_SUGGESTION_DAYS.standard).toBeLessThan(CLOSING_SUGGESTION_DAYS.paid);
  });

  it('suggests nothing when the form already has a closing date: nothing is overridden', () => {
    expect(suggestClosingDate({}, { opensAt: '', closedAt: '2026-12-01T12:00' }, NOW)).toBeNull();
  });

  it('counts from an opening still to come, never from today', () => {
    const suggestion = suggestClosingDate(
      { maxSubmissions: 10 },
      { opensAt: '2027-03-01T18:00', closedAt: '' },
      NOW
    );
    expect(suggestion?.value).toBe('2027-03-08T23:59');
  });

  it('counts from now when the opening has passed or is malformed', () => {
    expect(suggestClosingDate({}, { opensAt: '2026-11-01T09:00', closedAt: '' }, NOW)?.value).toBe(
      '2026-12-05T23:59'
    );
    expect(suggestClosingDate({}, { opensAt: 'garbage', closedAt: '' }, NOW)?.value).toBe(
      '2026-12-05T23:59'
    );
  });

  it('crosses a month and a year end', () => {
    expect(suggestClosingDate({}, { opensAt: '', closedAt: '' }, at(2026, 12, 25))?.value).toBe(
      '2027-01-08T23:59'
    );
  });
});
