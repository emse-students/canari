import { describe, expect, it } from 'vitest';
import type { SlotUnit } from './api';
import { weekLayout } from './grid';
import {
  dayUnits,
  endChoices,
  planningDays,
  planningKind,
  resolveRange,
  startChoices,
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

  it('resolves a start and an end to the first unit and how many it covers, or to nothing when stale', () => {
    expect(resolveRange(units, units[0].startMs, units[1].endMs, 8)).toEqual({
      first: units[0],
      count: 2,
    });
    // Over the booking, past the limit, or from a taken unit: nothing.
    expect(resolveRange(units, units[0].startMs, units[3].endMs, 8)).toBeNull();
    expect(resolveRange(units, units[0].startMs, units[1].endMs, 1)).toBeNull();
    expect(resolveRange(units, units[2].startMs, units[2].endMs, 8)).toBeNull();
  });
});
