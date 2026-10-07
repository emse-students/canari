import { describe, expect, it } from 'vitest';
import { linkableEventPickerOptions } from './time';

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
