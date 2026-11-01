/**
 * THE DASHBOARD'S COUNTERS (WP-R5, Q-R16) are read from the week's slots: every column, the days of
 * the week shown only (the day before the read is not the week), each booking once whatever
 * its number of units.
 */
import { describe, expect, it } from 'vitest';
import type { ResourceSlots, SlotUnit } from './api';
import { upcomingDays, weekBookingCount } from './dashboard';

const STEP = 30 * 60_000;
const at = (iso: string) => Date.parse(iso);

function u(startIso: string, extra: Partial<SlotUnit> & { state: SlotUnit['state'] }): SlotUnit {
  const startMs = at(startIso);
  return { date: startIso.slice(0, 10), startMs, endMs: startMs + STEP, ...extra } as SlotUnit;
}
const booked = (iso: string, id: string) =>
  u(iso, { state: 'booked', booking: { id } as never } as Partial<SlotUnit> & { state: 'booked' });
const blocked = (iso: string, blockId: string) =>
  u(iso, { state: 'blocked', blockId } as Partial<SlotUnit> & { state: 'blocked' });
const free = (iso: string) => u(iso, { state: 'free' });

const WEEK = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
  '2026-11-07',
  '2026-11-08',
];

describe('weekBookingCount', () => {
  it('counts each booking once, over every column, the week only, never a block', () => {
    const slots: ResourceSlots[] = [
      {
        resourceId: 'r1',
        units: [
          // Sunday before the week: in the read, not in the week.
          booked('2026-11-01T10:00:00Z', 'before'),
          booked('2026-11-02T10:00:00Z', 'b1'),
          booked('2026-11-02T10:30:00Z', 'b1'),
          free('2026-11-02T11:00:00Z'),
          blocked('2026-11-03T08:00:00Z', 'k1'),
          blocked('2026-11-03T08:30:00Z', 'k1'),
        ],
      },
      {
        resourceId: 'r2',
        units: [booked('2026-11-04T09:00:00Z', 'b2'), free('2026-11-04T09:30:00Z')],
      },
    ];
    expect(weekBookingCount(slots, WEEK, 'UTC')).toBe(2);
  });

  it('reads a unit on the day it starts in the space zone', () => {
    // 23:30 UTC on Sunday is Monday 00:30 in Paris: inside the week there, outside in UTC.
    const slots: ResourceSlots[] = [
      { resourceId: 'r1', units: [booked('2026-11-01T23:30:00Z', 'b')] },
    ];
    expect(weekBookingCount(slots, WEEK, 'Europe/Paris')).toBe(1);
    expect(weekBookingCount(slots, WEEK, 'UTC')).toBe(0);
  });

  it('is zero for an empty week', () => {
    expect(weekBookingCount([], WEEK, 'UTC')).toBe(0);
  });
});

describe('upcomingDays (the "coming" list by day, D50)', () => {
  const b = (id: string, startsAt: string) => ({ id, startsAt });
  const NOW = at('2026-11-02T08:00:00Z');

  it("heads today, tomorrow, then the date, in the space's zone and the server's order", () => {
    const days = upcomingDays(
      [
        b('a', '2026-11-02T07:30:00Z'),
        b('b', '2026-11-02T18:00:00Z'),
        b('c', '2026-11-03T09:00:00Z'),
        b('d', '2026-11-05T09:00:00Z'),
      ],
      'UTC',
      NOW
    );
    expect(days.map((d) => [d.date, d.items.map((i) => i.id)])).toEqual([
      ['2026-11-02', ['a', 'b']],
      ['2026-11-03', ['c']],
      ['2026-11-05', ['d']],
    ]);
    expect(days[0].label).not.toBe(days[1].label);
  });

  it('reads the day in the space zone, not UTC', () => {
    // 23:30 UTC on the 2nd is already the 3rd in Paris.
    const [day] = upcomingDays([b('a', '2026-11-02T23:30:00Z')], 'Europe/Paris', NOW);
    expect(day.date).toBe('2026-11-03');
  });

  it('puts a booking under way since yesterday under today', () => {
    const days = upcomingDays(
      [b('a', '2026-11-01T23:00:00Z'), b('b', '2026-11-02T10:00:00Z')],
      'UTC',
      NOW
    );
    expect(days.map((d) => [d.date, d.items.length])).toEqual([['2026-11-02', 2]]);
  });
});
