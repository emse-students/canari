import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import type { SlotUnit } from './api';
import {
  BLOCK_LENGTH_CHOICES,
  bookingUnitLimit,
  gridUnitLimit,
  dragRange,
  formatTimeRange,
  formatDayHead,
  formatWeekRange,
  freeCount,
  freeRunFrom,
  isPastUnit,
  slotsReadRange,
  unitDay,
  weekDates,
  weekLayout,
  weekReadRange,
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

  it('runs across the midnight between two whole open days, as the server accepts', () => {
    // Monday's window ends at 24:00, Tuesday's starts at 00:00: one continuous opening.
    const night = [
      {
        date: '2026-11-02',
        startMs: at('2026-11-02T22:00:00Z'),
        endMs: at('2026-11-02T23:00:00Z'),
        state: 'free' as const,
      },
      {
        date: '2026-11-03',
        startMs: at('2026-11-02T23:00:00Z'),
        endMs: at('2026-11-03T00:00:00Z'),
        state: 'free' as const,
      },
    ];
    expect(freeRunFrom(night, night[0], 4)).toHaveLength(2);
  });

  it('books a slot whole and steps up to maxSteps (D3)', () => {
    expect(bookingUnitLimit({ slotMode: 'slots', maxSteps: 4 })).toBe(1);
    expect(bookingUnitLimit({ slotMode: 'step', maxSteps: 4 })).toBe(4);
    expect(bookingUnitLimit({ slotMode: 'step', maxSteps: null })).toBe(1);
  });
});

const none = { opensAt: null, minNoticeMinutes: null, horizonDays: null };
const paris = { timeZone: PARIS, ...none };

/** A free unit of `minutes` starting at the Paris wall time `local` ("2026-11-03T10:00"). */
function parisUnit(local: string, minutes: number, offset = '+01:00'): SlotUnit {
  const startMs = at(`${local}:00${offset}`);
  return { date: local.slice(0, 10), startMs, endMs: startMs + minutes * 60_000, state: 'free' };
}

describe('the week (WP-R2, D46)', () => {
  it('is the ISO week, Monday first, whatever day of it is asked', () => {
    expect(weekDates('2026-11-04')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(weekDates('2026-11-08')[0]).toBe('2026-11-02');
    expect(weekDates('2026-11-02')[0]).toBe('2026-11-02');
  });

  it('reads from the day before the Monday, so a Sunday night window reaches Monday 00:30', () => {
    expect(weekReadRange('2026-11-05')).toEqual({ from: '2026-11-01', to: '2026-11-08' });
  });

  it('names the week and a day in the reader language', () => {
    expect(formatWeekRange(weekDates('2026-11-04'))).toMatch(/2.+8.+2026/);
    expect(formatDayHead('2026-11-04')).toMatchObject({ num: 4 });
  });

  it('places each unit by the wall time of its start, the same hour on every day', () => {
    const units = [parisUnit('2026-11-02T10:00', 30), parisUnit('2026-11-03T10:00', 30)];
    const layout = weekLayout(units, weekDates('2026-11-02'), paris, at('2026-11-01T00:00:00Z'));
    expect(layout.days.map((d) => d.state)).toEqual([
      'open',
      'open',
      'closed',
      'closed',
      'closed',
      'closed',
      'closed',
    ]);
    expect(layout.days[0].placed[0]).toMatchObject({ topMin: 600, heightMin: 30 });
    expect(layout.days[1].placed[0].topMin).toBe(600);
    // One axis for the week, whole hours around what is offered.
    expect([layout.startMin, layout.endMin]).toEqual([600, 660]);
  });

  it('starts the axis at the first hour ANY day opens, not at midnight, and ends after the last', () => {
    // Monday opens 08:00-09:00, Saturday 10:00-23:00 (Paris): the axis is the union, 08:00-23:00.
    const units = [
      parisUnit('2026-11-02T08:00', 60),
      parisUnit('2026-11-07T10:00', 60),
      parisUnit('2026-11-07T22:00', 60),
    ];
    const layout = weekLayout(units, weekDates('2026-11-02'), paris, at('2026-11-01T00:00:00Z'));
    expect([layout.startMin, layout.endMin]).toEqual([480, 1380]);
  });

  it('keeps 18:00 at 18:00 across the daylight-saving change (2026-10-24 to 2026-10-26)', () => {
    // 2026-10-25 02:00 Paris is the fall-back: Monday 26 is UTC+1, Saturday 24 was UTC+2.
    const units = [
      parisUnit('2026-10-24T18:00', 60, '+02:00'),
      parisUnit('2026-10-26T18:00', 60, '+01:00'),
    ];
    const layout = weekLayout(
      units,
      ['2026-10-24', '2026-10-25', '2026-10-26'],
      paris,
      at('2026-10-20T00:00:00Z')
    );
    const tops = layout.days.flatMap((d) => d.placed.map((p) => p.topMin));
    expect(tops).toEqual([1080, 1080]);
  });

  it('draws the doubled hour of a fall-back night side by side, and moves nothing else', () => {
    // 2026-10-25 in Paris lasts 25 hours: 02:00-03:00 happens twice (UTC+2, then UTC+1).
    const day = Array.from({ length: 25 }, (_, i) => {
      const startMs = at('2026-10-24T22:00:00Z') + i * 3_600_000;
      return { date: '2026-10-25', startMs, endMs: startMs + 3_600_000, state: 'free' as const };
    });
    const layout = weekLayout(day, ['2026-10-25'], paris, at('2026-10-20T00:00:00Z'));
    const placed = layout.days[0].placed;
    // The wall hours 0,1,2,2,3,4,...,23: every unit on its own wall time, the shift never carried.
    expect(placed.map((p) => p.topMin / 60)).toEqual([
      0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(placed.map((p) => [p.lane, p.lanes]).slice(0, 5)).toEqual([
      [0, 1],
      [0, 1],
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
    expect(layout.days[0].cells[2].startMs).toBeLessThan(layout.days[0].cells[3].startMs);
    expect([layout.startMin, layout.endMin]).toEqual([0, 1440]);
  });

  it('puts the morning of a night window on its own day, which the read that starts the day before holds', () => {
    // Friday 2026-11-06 22:00 to Saturday 02:00 (UTC+1): the server stamps all of it Friday.
    const night = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      date: '2026-11-06',
      startMs: at('2026-11-06T21:00:00Z') + i * 30 * 60_000,
      endMs: at('2026-11-06T21:00:00Z') + (i + 1) * 30 * 60_000,
      state: 'free' as const,
    }));
    const serverRead = ({ from, to }: { from: string; to: string }) =>
      night.filter((u) => from <= u.date && u.date <= to);
    const layout = weekLayout(
      serverRead(weekReadRange('2026-11-07')),
      weekDates('2026-11-07'),
      paris,
      at('2026-11-05T00:00:00Z')
    );
    const friday = layout.days[4];
    const saturday = layout.days[5];
    expect(friday.placed.map((p) => p.topMin)).toEqual([1320, 1350, 1380, 1410]);
    expect(saturday.placed.map((p) => p.topMin)).toEqual([0, 30, 60, 90]);
    // The axis reaches midnight and back: it spans the whole day.
    expect([layout.startMin, layout.endMin]).toEqual([0, 1440]);
  });

  it('puts Monday 00:30 of a Sunday night window in Monday, read from the Sunday before', () => {
    // Sunday 2026-11-01 22:00 to Monday 02:00 (UTC+1), stamped Sunday: outside Monday's own read.
    const unit: SlotUnit = {
      date: '2026-11-01',
      startMs: at('2026-11-01T23:30:00Z'),
      endMs: at('2026-11-02T00:00:00Z'),
      state: 'free',
    };
    expect(weekReadRange('2026-11-02').from).toBe('2026-11-01');
    const layout = weekLayout([unit], weekDates('2026-11-02'), paris, at('2026-10-30T00:00:00Z'));
    expect(layout.days[0].placed[0]).toMatchObject({ topMin: 30, heightMin: 30 });
  });

  it('folds a day with nothing offered and tells a full day from an open one', () => {
    const units: SlotUnit[] = [
      parisUnit('2026-11-02T10:00', 30),
      { ...parisUnit('2026-11-03T10:00', 30), state: 'blocked' },
    ];
    const layout = weekLayout(units, weekDates('2026-11-02'), paris, at('2026-11-01T00:00:00Z'));
    expect(layout.days.slice(0, 3).map((d) => d.state)).toEqual(['open', 'none', 'closed']);
  });

  it('counts a unit the booking window refuses on the device clock as not free', () => {
    const units = [parisUnit('2026-11-02T10:00', 30), parisUnit('2026-11-02T11:00', 30)];
    const now = at('2026-11-02T10:30:00+01:00');
    expect(freeCount(units, none, now)).toBe(1);
    const layout = weekLayout(units.slice(0, 1), ['2026-11-02'], paris, now);
    expect(layout.days[0].state).toBe('none');
  });

  it('shares the width between two slots that overlap, and gives a lone unit all of it', () => {
    const units = [parisUnit('2026-11-02T10:00', 60), parisUnit('2026-11-02T10:30', 60)];
    const lone = parisUnit('2026-11-02T14:00', 30);
    const layout = weekLayout([...units, lone], ['2026-11-02'], paris, at('2026-11-01T00:00:00Z'));
    expect(layout.days[0].placed.map((p) => [p.lane, p.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it('is tall enough that the shortest unit holds a line of text, and capped', () => {
    const short = weekLayout(
      [parisUnit('2026-11-02T10:00', 15)],
      ['2026-11-02'],
      paris,
      at('2026-11-01T00:00:00Z')
    );
    expect(short.remPerHour).toBe(7);
    const long = weekLayout(
      [parisUnit('2026-11-02T10:00', 120)],
      ['2026-11-02'],
      paris,
      at('2026-11-01T00:00:00Z')
    );
    expect(long.remPerHour).toBe(4);
  });

  it('has no axis when nothing is offered', () => {
    const layout = weekLayout([], weekDates('2026-11-02'), paris, 0);
    expect([layout.startMin, layout.endMin]).toEqual([0, 0]);
    expect(layout.days.every((d) => d.state === 'closed')).toBe(true);
  });
});

describe('the read of a night window', () => {
  it('starts the day before, so the 00:30 unit is in hand (the server keeps a unit by its window date)', () => {
    expect(slotsReadRange('2026-11-07', 14)).toEqual({ from: '2026-11-06', to: '2026-11-20' });
  });
});

describe('dragRange', () => {
  const column = [
    unit('09:00', 30),
    unit('09:30', 30),
    unit('10:00', 30),
    unit('10:30', 30, 'blocked'),
    unit('11:00', 30),
    unit('11:30', 30),
  ];

  it('grows from the pressed row toward the pointer, downward and upward', () => {
    expect(dragRange(column, 0, 2, 4)).toEqual({ first: 0, count: 3 });
    expect(dragRange(column, 2, 0, 4)).toEqual({ first: 0, count: 3 });
  });

  it('is one unit while the pointer has not left the pressed row', () => {
    expect(dragRange(column, 1, 1, 4)).toEqual({ first: 1, count: 1 });
  });

  it('never covers more than one booking may', () => {
    expect(dragRange(column, 0, 2, 2)).toEqual({ first: 0, count: 2 });
    expect(dragRange(column, 2, 0, 2)).toEqual({ first: 1, count: 2 });
  });

  it('stops before a taken unit, however far the pointer went', () => {
    expect(dragRange(column, 1, 5, 6)).toEqual({ first: 1, count: 2 });
    expect(dragRange(column, 5, 0, 6)).toEqual({ first: 4, count: 2 });
  });

  it('stops at a gap between two windows and at a row with no unit', () => {
    const gapped = [unit('09:00', 30), unit('11:00', 30), null, unit('12:00', 30)];
    expect(dragRange(gapped, 0, 1, 4)).toEqual({ first: 0, count: 1 });
    expect(dragRange(gapped, 3, 0, 4)).toEqual({ first: 3, count: 1 });
  });

  it('selects nothing when the pressed row is not a free unit', () => {
    expect(dragRange(column, 3, 5, 4).count).toBe(0);
    expect(dragRange([null, unit('09:00', 30)], 0, 1, 4).count).toBe(0);
    expect(dragRange(column, 0, 2, 0).count).toBe(0);
  });
});

describe('gridUnitLimit', () => {
  it('is a block length on the dashboard (slots mode included), a booking length otherwise', () => {
    expect(gridUnitLimit({ slotMode: 'slots', maxSteps: null }, true)).toBe(BLOCK_LENGTH_CHOICES);
    expect(gridUnitLimit({ slotMode: 'slots', maxSteps: null }, false)).toBe(1);
    expect(gridUnitLimit({ slotMode: 'step', maxSteps: 4 }, false)).toBe(4);
  });
});

describe('a unit that is over', () => {
  it('is past once it has ended on the device clock, and not before', () => {
    const u = unit('10:00', 30);
    expect(isPastUnit(u, u.endMs - 1)).toBe(false);
    expect(isPastUnit(u, u.endMs)).toBe(true);
  });
});
