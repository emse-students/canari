import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import type { ResourceSlots, SlotUnit } from './api';
import {
  bookingUnitLimit,
  formatTimeRange,
  freeRunFrom,
  gridOpeningDate,
  gridRows,
  planning,
  slotsReadRange,
  unitDay,
  windowRefusal,
} from './grid';
import { localTime } from './zonedTime';

const PARIS = 'Europe/Paris';
const at = (iso: string) => Date.parse(iso);

/** A unit on 2026-11-02 (Paris, UTC+1), from `h:m` local for `minutes`. */
function unit(start: string, minutes: number, state: 'free' | 'blocked' = 'free'): SlotUnit {
  const startMs = at(`2026-11-02T${start}:00+01:00`);
  return { date: '2026-11-02', startMs, endMs: startMs + minutes * 60_000, state };
}

describe("a unit's day and its range, on the space's clock (D25)", () => {
  it("names a unit by the day of its START, not by its window's date", () => {
    const night = { date: '2026-11-06', startMs: at('2026-11-06T23:30:00Z') };
    expect(unitDay(night, PARIS)).toBe('2026-11-07');
  });

  it('writes the end of a day as 24:00, never 00:00', () => {
    expect(formatTimeRange(at('2026-11-02T22:30:00Z'), at('2026-11-02T23:00:00Z'), PARIS)).toBe(
      '23:30 - 24:00'
    );
  });

  it('marks an end on the next day, and names the day of an end further on', () => {
    expect(formatTimeRange(at('2026-11-06T21:00:00Z'), at('2026-11-07T01:00:00Z'), PARIS)).toBe(
      `22:00 - 02:00 ${m.bookings_time_next_day()}`
    );
    const long = formatTimeRange(at('2026-11-06T09:00:00Z'), at('2026-11-08T09:00:00Z'), PARIS);
    expect(long.startsWith('10:00 - ')).toBe(true);
    expect(long.endsWith(' 10:00')).toBe(true);
    expect(long).not.toBe('10:00 - 10:00');
  });

  it('keeps 18:00 at 18:00 across the daylight-saving change', () => {
    expect(localTime(at('2026-10-24T16:00:00Z'), PARIS)).toBe('18:00');
    expect(localTime(at('2026-10-26T17:00:00Z'), PARIS)).toBe('18:00');
  });

  it('tells the doubled hour of a fall-back night apart by its offset, and only that hour', () => {
    // 2026-10-25 in Paris: 02:00-03:00 happens at 00:00Z (UTC+2), then again at 01:00Z (UTC+1).
    expect(formatTimeRange(at('2026-10-24T23:00:00Z'), at('2026-10-25T00:00:00Z'), PARIS)).toBe(
      '01:00 - 02:00 (UTC+2)'
    );
    expect(formatTimeRange(at('2026-10-25T00:00:00Z'), at('2026-10-25T01:00:00Z'), PARIS)).toBe(
      '02:00 (UTC+2) - 02:00 (UTC+1)'
    );
    expect(formatTimeRange(at('2026-10-25T01:00:00Z'), at('2026-10-25T02:00:00Z'), PARIS)).toBe(
      '02:00 (UTC+1) - 03:00'
    );
    expect(formatTimeRange(at('2026-10-25T02:00:00Z'), at('2026-10-25T03:00:00Z'), PARIS)).toBe(
      '03:00 - 04:00'
    );
  });

  it('a spring-forward night has no 02:00 to draw', () => {
    // 2026-03-29 in Paris: 01:30 + 30 min is 03:00.
    expect(formatTimeRange(at('2026-03-29T00:30:00Z'), at('2026-03-29T01:00:00Z'), PARIS)).toBe(
      '01:30 - 03:00'
    );
  });
});

describe('windowRefusal mirrors the server (D26)', () => {
  const now = at('2026-11-02T08:00:00Z');
  const none = { opensAt: null, minNoticeMinutes: null, horizonDays: null };

  it('refuses a started unit, accepts a coming one', () => {
    expect(windowRefusal(none, now, now)).toBe('started');
    expect(windowRefusal(none, now + 1, now)).toBeNull();
  });

  it('applies the opening first, then the notice, then the horizon', () => {
    const opening = { ...none, opensAt: '2026-11-03T00:00:00Z' };
    expect(windowRefusal(opening, now - 1, now)).toBe('not-open-yet');
    const notice = { ...none, minNoticeMinutes: 60 };
    expect(windowRefusal(notice, now + 59 * 60_000, now)).toBe('notice');
    expect(windowRefusal(notice, now + 60 * 60_000, now)).toBeNull();
    const horizon = { ...none, horizonDays: 7 };
    expect(windowRefusal(horizon, now + 7 * 86_400_000 + 1, now)).toBe('beyond-horizon');
  });
});

describe('gridRows', () => {
  it('lays one date out as rows of ranges, a column per resource, empty where none', () => {
    const slots: ResourceSlots[] = [
      { resourceId: 'a', units: [unit('10:00', 30), unit('09:00', 30)] },
      {
        resourceId: 'b',
        units: [
          unit('09:00', 30),
          { ...unit('09:00', 30), date: '2026-11-03', startMs: 1, endMs: 2 },
        ],
      },
    ];
    const rows = gridRows(['a', 'b'], slots, '2026-11-02', PARIS);
    expect(rows.map((r) => r.label)).toEqual(['09:00 - 09:30', '10:00 - 10:30']);
    expect(rows.every((r) => !r.nextDay)).toBe(true);
    expect(rows[0].cells.every((c) => c !== null)).toBe(true);
    expect(rows[1].cells[0]?.state).toBe('free');
    expect(rows[1].cells[1]).toBeNull();
  });
});

describe('a night window on the grid', () => {
  it("keeps its after-midnight units on the window's date, marked as the next day", () => {
    const late = {
      date: '2026-11-06',
      startMs: at('2026-11-06T22:30:00Z'),
      state: 'free' as const,
    };
    const units: SlotUnit[] = [
      { ...late, endMs: late.startMs + 30 * 60_000 },
      { ...late, startMs: late.startMs + 30 * 60_000, endMs: late.startMs + 60 * 60_000 },
    ];
    const rows = gridRows(['a'], [{ resourceId: 'a', units }], '2026-11-06', PARIS);
    expect(rows.map((r) => [r.label, r.nextDay])).toEqual([
      ['23:30 - 24:00', false],
      ['00:00 - 00:30', true],
    ]);
  });
});

describe('freeRunFrom', () => {
  const units = [unit('09:00', 30), unit('09:30', 30), unit('10:00', 30, 'blocked')];

  it('covers consecutive free units up to the limit', () => {
    expect(freeRunFrom(units, units[0], 5)).toHaveLength(2);
    expect(freeRunFrom(units, units[0], 1)).toHaveLength(1);
  });

  it('stops at a gap between two windows', () => {
    const gapped = [unit('09:00', 30), unit('11:00', 30)];
    expect(freeRunFrom(gapped, gapped[0], 5)).toHaveLength(1);
  });

  it('offers nothing from a unit that is not free', () => {
    expect(freeRunFrom(units, units[2], 5)).toEqual([]);
  });

  it('books a slot whole and steps up to maxSteps (D3)', () => {
    expect(bookingUnitLimit({ slotMode: 'slots', maxSteps: 4 })).toBe(1);
    expect(bookingUnitLimit({ slotMode: 'step', maxSteps: 4 })).toBe(4);
    expect(bookingUnitLimit({ slotMode: 'step', maxSteps: null })).toBe(1);
  });
});

describe('planning', () => {
  it('lists the next free units the window accepts, and keeps a full resource, empty', () => {
    const slots: ResourceSlots[] = [
      { resourceId: 'a', units: [unit('09:00', 30), unit('10:00', 30), unit('11:00', 30)] },
      { resourceId: 'b', units: [unit('09:00', 30, 'blocked')] },
    ];
    const now = at('2026-11-02T08:30:00Z'); // 09:30 in Paris
    const rows = planning(
      { opensAt: null, minNoticeMinutes: null, horizonDays: null },
      ['a', 'b'],
      slots,
      now,
      1
    );
    expect(rows[0].units.map((u) => localTime(u.startMs, PARIS))).toEqual(['10:00']);
    expect(rows[1].units).toEqual([]);
  });
});

describe('a night window still running after midnight (Saturday 00:15, Paris)', () => {
  // Friday 2026-11-06 22:00 to Saturday 02:00 in Paris (UTC+1): one window, stamped Friday by the
  // server, in steps of 30 min. The member opens the page on Saturday at 00:15.
  const friday = '2026-11-06';
  const saturday = '2026-11-07';
  const windowStart = at('2026-11-06T21:00:00Z');
  const night: SlotUnit[] = Array.from({ length: 8 }, (_, i) => ({
    date: friday,
    startMs: windowStart + i * 30 * 60_000,
    endMs: windowStart + (i + 1) * 30 * 60_000,
    state: 'free' as const,
  }));
  const saturdayMorning = {
    date: saturday,
    startMs: at('2026-11-07T09:00:00Z'),
    endMs: at('2026-11-07T09:30:00Z'),
    state: 'free' as const,
  };
  /** The server's `spaceSlots(from, to)`: a unit is kept when its WINDOW's date is in the range. */
  const serverRead = ({ from, to }: { from: string; to: string }): ResourceSlots[] => [
    {
      resourceId: 'room',
      units: [...night, saturdayMorning].filter((u) => from <= u.date && u.date <= to),
    },
  ];
  const now = at('2026-11-06T23:15:00Z'); // Saturday 00:15 in Paris
  const none = { opensAt: null, minNoticeMinutes: null, horizonDays: null };
  const halfPastMidnight = at('2026-11-06T23:30:00Z');

  it('reads from the day before, so the 00:30 unit is in hand', () => {
    expect(slotsReadRange(saturday, 14)).toEqual({ from: friday, to: '2026-11-20' });
    const read = serverRead(slotsReadRange(saturday, 7));
    expect(read[0].units.some((u) => u.startMs === halfPastMidnight)).toBe(true);
    // The read that started on Saturday lost it.
    const old = serverRead({ from: saturday, to: '2026-11-13' });
    expect(old[0].units.some((u) => u.startMs === halfPastMidnight)).toBe(false);
  });

  it("opens the grid on Friday's window, whose rest of the night is drawn as the next day", () => {
    const read = serverRead(slotsReadRange(saturday, 7));
    const opening = gridOpeningDate(read, saturday, now);
    expect(opening).toBe(friday);
    const rows = gridRows(['room'], read, opening, PARIS);
    expect(rows.find((r) => r.startMs === halfPastMidnight)).toMatchObject({
      label: '00:30 - 01:00',
      nextDay: true,
    });
  });

  it('lists the 00:30 unit first in the planning, the 00:00 one having started', () => {
    const read = serverRead(slotsReadRange(saturday, 14));
    const [room] = planning(none, ['room'], read, now, 2);
    expect(room.units.map((u) => localTime(u.startMs, PARIS))).toEqual(['00:30', '01:00']);
  });

  it('opens on today once the night window has ended', () => {
    const read = serverRead(slotsReadRange(saturday, 7));
    expect(gridOpeningDate(read, saturday, at('2026-11-07T01:00:00Z'))).toBe(saturday);
  });
});
