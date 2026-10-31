import { describe, expect, it } from 'vitest';
import type { MyBooking } from './api';
import { MINE_HERE_LIMIT, mineHere } from './mineHere';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const hour = 3_600_000;

function row(id: string, startOffsetH: number, over: Partial<MyBooking> = {}): MyBooking {
  return {
    id,
    startsAt: new Date(NOW + startOffsetH * hour).toISOString(),
    endsAt: new Date(NOW + (startOffsetH + 1) * hour).toISOString(),
    cancelled: false,
    withdrawn: false,
    space: { id: 's1', name: 'Salle', timeZone: 'Europe/Paris' },
    ...over,
  } as MyBooking;
}

describe("the reader's coming bookings in one space", () => {
  it('keeps only this space, soonest first', () => {
    const rows = [
      row('late', 5),
      row('other', 1, { space: { id: 's2', name: 'x', timeZone: 'Europe/Paris' } }),
      row('soon', 2),
    ];
    expect(mineHere(rows, 's1', NOW).map((b) => b.id)).toEqual(['soon', 'late']);
  });

  it('leaves out a cancelled booking, one the reader left and one already over', () => {
    const rows = [
      row('cancelled', 2, { cancelled: true }),
      row('left', 3, { withdrawn: true }),
      row('over', -3),
      row('running', -0.5),
    ];
    expect(mineHere(rows, 's1', NOW).map((b) => b.id)).toEqual(['running']);
  });

  it('draws at most the limit and reads any iterable (the page holds a Map)', () => {
    const rows = new Map(
      Array.from({ length: MINE_HERE_LIMIT + 3 }, (_, i) => [`b${i}`, row(`b${i}`, i + 1)] as const)
    );
    expect(mineHere(rows.values(), 's1', NOW)).toHaveLength(MINE_HERE_LIMIT);
  });
});
