/**
 * THE PHONE'S AGENDA WINDOW IS ARITHMETIC, AND ARITHMETIC ABOUT MONTHS IS WHERE CALENDARS BREAK.
 *
 * Three things are pinned here, each of which is invisible until a particular day of a particular
 * month: the first step starts on TODAY rather than on the 1st (which is the whole point of the
 * shape), consecutive steps neither overlap nor leave a gap, and the horizon lands on the last day
 * of the twelfth month rather than one month either side of it.
 *
 * Every date is stated, never read from the clock: a test that asserts against `new Date()` passes
 * for 27 days a month and tells you nothing about the other four.
 */
import { describe, it, expect } from 'vitest';
import {
  rollingChunkRangeISO,
  rollingWindowEnd,
  ROLLING_HORIZON_MONTHS,
} from './agendaMonth.svelte';

/** The local parts of an ISO instant - what the reader's calendar actually shows. */
function local(iso: string): [number, number, number, number] {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()];
}

describe('rollingChunkRangeISO', () => {
  it('opens the window on the day given, not on the first of its month', () => {
    // The 28th is the case the shape exists for: a month-aligned agenda opens on 27 dead days.
    const range = rollingChunkRangeISO(new Date(2026, 8, 28), 0, 3);

    expect(local(range.from)).toEqual([2026, 8, 28, 0]);
  });

  it('ends a three-month step on the last day of the third month', () => {
    const range = rollingChunkRangeISO(new Date(2026, 8, 28), 0, 3);

    // September + October + November, and November has 30 days.
    expect(local(range.to)).toEqual([2026, 10, 30, 23]);
  });

  it('starts every later step on the first of its month, the day after the last step ended', () => {
    const first = rollingChunkRangeISO(new Date(2026, 8, 28), 0, 3);
    const second = rollingChunkRangeISO(new Date(2026, 8, 28), 3, 3);

    expect(local(second.from)).toEqual([2026, 11, 1, 0]);
    // No gap and no overlap: one day apart to the millisecond, with nothing between them.
    expect(new Date(second.from).getTime() - new Date(first.to).getTime()).toBe(1);
  });

  it('crosses a year boundary without losing a month', () => {
    const range = rollingChunkRangeISO(new Date(2026, 10, 15), 3, 3);

    // November + 3 = February; February 2027 has 28 days.
    expect(local(range.from)).toEqual([2027, 1, 1, 0]);
    expect(local(range.to)).toEqual([2027, 3, 30, 23]);
  });

  it('reaches exactly twelve months once every step has been taken', () => {
    const start = new Date(2026, 8, 28);
    let loaded = 0;
    let last = rollingChunkRangeISO(start, 0, 3);
    while (loaded < ROLLING_HORIZON_MONTHS) {
      const count = Math.min(3, ROLLING_HORIZON_MONTHS - loaded);
      last = rollingChunkRangeISO(start, loaded, count);
      loaded += count;
    }

    // The twelfth month after September 2026 is August 2027, and it has 31 days.
    expect(loaded).toBe(12);
    expect(local(last.to)).toEqual([2027, 7, 31, 23]);
  });
});

describe('rollingWindowEnd', () => {
  it('answers with the day before the window opens while nothing is loaded', () => {
    // An empty range, which is what the list must draw before its first chunk lands - not a month
    // of days it has no events for.
    const end = rollingWindowEnd(new Date(2026, 8, 28), 0);

    expect(end.getTime()).toBeLessThan(new Date(2026, 8, 28).getTime());
  });

  it('follows the last month fetched, whatever its length', () => {
    expect(local(rollingWindowEnd(new Date(2027, 0, 10), 2).toISOString())).toEqual([
      2027, 1, 28, 23,
    ]);
  });
});
