import { describe, expect, it } from 'vitest';
import type { SlotUnit } from './api';
import { isOfferedStart, weekLayout } from './grid';
import {
  dayUnits,
  endChoices,
  planningDays,
  planningKind,
  startChoices,
  unitKey,
} from './planning';

const space = {
  timeZone: 'UTC',
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
};
const NOW = Date.parse('2026-11-01T00:00:00Z');
const HALF = 30 * 60_000;
/** A 30-minute unit at `hour` (UTC) on 2026-11-02, free unless told otherwise. */
const unit = (hour: number, state: 'free' | 'booked' | 'blocked' = 'free'): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: Date.parse('2026-11-02T00:00:00Z') + hour * 3_600_000,
    endMs: Date.parse('2026-11-02T00:00:00Z') + hour * 3_600_000 + HALF,
    state,
    ...(state === 'booked'
      ? { booking: { id: 'b1', holderName: 'Camille Test', mine: false } }
      : {}),
  }) as SlotUnit;

// 09:00 free, 09:30 free, 10:00 booked, 10:30 free (a booking splits the free time).
const units = [
  unit(9),
  { ...unit(9), startMs: unit(9).startMs + HALF, endMs: unit(9).endMs + HALF },
  unit(10, 'booked'),
  { ...unit(10), startMs: unit(10).startMs + HALF, endMs: unit(10).endMs + HALF },
] as SlotUnit[];

describe('the planning (phone)', () => {
  it('lists a day as merged rows and drops what is over', () => {
    const layout = weekLayout(units, ['2026-11-02', '2026-11-03'], space, NOW);
    const days = planningDays(layout, planningKind(space, NOW, null, false), false);
    expect(days.map((d) => d.rows.map((r) => r.kind))).toEqual([['free', 'booked', 'free'], []]);
    expect(days[0].rows[0].units).toHaveLength(2);
    const late = planningDays(
      layout,
      planningKind(space, Date.parse('2026-11-02T09:40:00Z'), null, false),
      false
    );
    // The first free half hour is over: its row is gone, the 09:30 one is already running.
    expect(late[0].rows[0].startMs).toBe(units[1].startMs);
  });

  it('reads a free unit the window refuses as closed for a booker, free for the organiser', () => {
    const notice = { ...space, minNoticeMinutes: 48 * 60 };
    expect(planningKind(notice, NOW, null, false)(units[0])).toBe('closed');
    expect(planningKind(notice, NOW, null, true)(units[0])).toBe('free');
  });

  it('offers as starts only free units the window takes, and as ends only the contiguous free run', () => {
    const offered = () => true;
    expect(startChoices(dayUnits(units, '2026-11-02', 'UTC'), offered)).toHaveLength(3);
    expect(startChoices(units, (u) => u.startMs > units[0].startMs)).toHaveLength(2);
    expect(endChoices(units, units[0], 8).map((u) => u.endMs)).toEqual([
      units[0].endMs,
      units[1].endMs,
    ]);
    // A booking ends the run, and the limit caps it.
    expect(endChoices(units, units[0], 1)).toHaveLength(1);
  });

  it('keys a unit by its start AND end, so two slots starting together are two choices', () => {
    const short = { ...unit(9), endMs: unit(9).startMs + 2 * HALF } as SlotUnit;
    const long = { ...unit(9), endMs: unit(9).startMs + 4 * HALF } as SlotUnit;
    expect(short.startMs).toBe(long.startMs);
    expect(unitKey(short)).not.toBe(unitKey(long));
    // A run starting on the long slot is found by both ends, never by the start alone.
    expect(endChoices([short, long], long, 1).map((u) => u.endMs)).toEqual([long.endMs]);
  });

  it('does not offer a block organiser a unit that has begun, nor one that is over', () => {
    const now = unit(9).startMs + 10 * 60_000; // 09:10: the 09:00 half hour is running
    const kind = planningKind(space, now, null, true);
    expect(kind(unit(9))).toBe('closed');
    expect(kind(units[1])).toBe('free');
    // The booker's rule is the window's: the running unit is already refused as started.
    expect(planningKind(space, now, null, false)(unit(9))).toBe('closed');
    expect(
      startChoices(units, (u) => isOfferedStart(space, u, now, null, true)).map((u) => u.startMs)
    ).toEqual([units[1].startMs, units[3].startMs]);
  });

  it('lists a fall-back day (25 hours) with two distinct rows for the doubled hour', () => {
    const paris = { ...space, timeZone: 'Europe/Paris' };
    const hour = (utcHour: number): SlotUnit =>
      ({
        date: '2026-10-25',
        startMs: Date.parse('2026-10-25T00:00:00Z') + utcHour * 3_600_000,
        endMs: Date.parse('2026-10-25T00:00:00Z') + (utcHour + 1) * 3_600_000,
        state: utcHour === 1 ? 'booked' : 'free',
        ...(utcHour === 1 ? { booking: { id: 'b', holderName: 'Camille Test', mine: false } } : {}),
      }) as SlotUnit;
    // 02:00 UTC+2 and 02:00 UTC+1 are the same wall time: units at 00:00Z, 01:00Z (both "02:00").
    const day = [hour(0), hour(1), hour(2)];
    const layout = weekLayout(day, ['2026-10-25'], paris, Date.parse('2026-10-24T00:00:00Z'));
    const rows = planningDays(layout, planningKind(paris, 0, null, false), false)[0].rows;
    expect(rows.map((r) => r.kind)).toEqual(['free', 'booked', 'free']);
    expect(new Set(day.map(unitKey)).size).toBe(3);
  });
});
