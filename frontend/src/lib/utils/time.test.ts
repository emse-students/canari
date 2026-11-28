import { describe, expect, it } from 'vitest';
import { linkableEventPickerOptions, shortDate, shortDateTime } from './time';

describe('shortDate', () => {
  it('writes DD/MM/YY in local time, zero-padded', () => {
    expect(shortDate(new Date(2026, 10, 25, 12).toISOString())).toBe('25/11/26');
    expect(shortDate(new Date(2027, 0, 3, 12).toISOString())).toBe('03/01/27');
  });
});

describe('linkableEventPickerOptions', () => {
  const ev = (id: string, startsAt: string) => ({ id, startsAt, title: id });

  it('keeps "no event" first, then furthest future down to furthest past', () => {
    const options = linkableEventPickerOptions(
      [
        ev('past', '2026-01-10T10:00:00Z'),
        ev('far', '2027-03-01T10:00:00Z'),
        ev('soon', '2026-11-01T10:00:00Z'),
      ],
      false
    );
    expect(options.map((o) => o.value)).toEqual(['', 'far', 'soon', 'past']);
  });

  it('does not reorder the caller array', () => {
    const events = [ev('a', '2026-01-01T00:00:00Z'), ev('b', '2027-01-01T00:00:00Z')];
    linkableEventPickerOptions(events, false);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('shortDateTime', () => {
  it('writes the day and the local hour of a record, zero-padded', () => {
    expect(shortDateTime(new Date(2026, 10, 25, 9, 5).toISOString())).toBe('25/11/26 09:05');
    expect(shortDateTime(new Date(2027, 0, 3, 23, 41).toISOString())).toBe('03/01/27 23:41');
  });
});
