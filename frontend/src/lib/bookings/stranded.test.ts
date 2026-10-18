import { describe, expect, it } from 'vitest';
import { BookingsApiError } from './api';
import { rangeInZone, strandedIdsOf } from './stranded';

const refused = (code: string | null, ids: string[]) =>
  new BookingsApiError('dev text', code, 409, ids);

describe('strandedIdsOf', () => {
  it('reads the ids of the two refusals that name bookings (D29), and of nothing else', () => {
    expect(strandedIdsOf(refused('bookings-inside-change', ['a', 'b']))).toEqual(['a', 'b']);
    expect(strandedIdsOf(refused('bookings-inside-block', ['c']))).toEqual(['c']);
    expect(strandedIdsOf(refused('time-zone', ['a']))).toEqual([]);
    expect(strandedIdsOf(refused(null, ['a']))).toEqual([]);
    expect(strandedIdsOf(new Error('network'))).toEqual([]);
  });
});

describe('rangeInZone', () => {
  it("reads the range on the SPACE's clock, whatever the device's", () => {
    // 09:00Z is 10:00 in Paris in November and 18:00 in Tokyo.
    const paris = rangeInZone(
      '2026-11-02T09:00:00Z',
      '2026-11-02T09:30:00Z',
      'Europe/Paris',
      'en-GB'
    );
    expect(paris).toBe('Mon 2 Nov, 10:00 - 10:30');
    expect(rangeInZone('2026-11-02T09:00:00Z', '2026-11-02T09:30:00Z', 'Asia/Tokyo', 'en-GB')).toBe(
      'Mon 2 Nov, 18:00 - 18:30'
    );
  });

  it('names the end day when the range crosses midnight, and writes midnight as 00:00', () => {
    expect(
      rangeInZone('2026-11-06T21:00:00Z', '2026-11-07T01:00:00Z', 'Europe/Paris', 'en-GB')
    ).toBe('Fri 6 Nov, 22:00 - Sat 7 Nov, 02:00');
    expect(
      rangeInZone('2026-11-06T22:30:00Z', '2026-11-06T23:00:00Z', 'Europe/Paris', 'en-GB')
    ).toBe('Fri 6 Nov, 23:30 - Sat 7 Nov, 00:00');
  });
});
