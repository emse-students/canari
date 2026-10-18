import { describe, expect, it } from 'vitest';
import type { ResourceSlots, SlotUnit } from './api';
import {
  addDays,
  bookingUnitLimit,
  freeRunFrom,
  gridRows,
  localDateIn,
  localTimeIn,
  planning,
  windowRefusal,
} from './grid';

const PARIS = 'Europe/Paris';
const at = (iso: string) => Date.parse(iso);

/** A unit on 2026-11-02 (Paris, UTC+1), from `h:m` local for `minutes`. */
function unit(start: string, minutes: number, state: 'free' | 'blocked' = 'free'): SlotUnit {
  const startMs = at(`2026-11-02T${start}:00+01:00`);
  return { date: '2026-11-02', startMs, endMs: startMs + minutes * 60_000, state };
}

describe('the space zone', () => {
  it('reads an instant as the space reads it, whatever the device zone', () => {
    const instant = at('2026-11-02T23:30:00Z');
    expect(localDateIn(instant, PARIS)).toBe('2026-11-03');
    expect(localTimeIn(instant, PARIS)).toBe('00:30');
    expect(localDateIn(instant, 'America/New_York')).toBe('2026-11-02');
  });

  it('keeps 18:00 at 18:00 across the daylight-saving change (D25)', () => {
    expect(localTimeIn(at('2026-10-24T16:00:00Z'), PARIS)).toBe('18:00');
    expect(localTimeIn(at('2026-10-26T17:00:00Z'), PARIS)).toBe('18:00');
  });

  it('adds calendar days across a month and a year', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
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
    const rows = gridRows(['a', 'b'], slots, '2026-11-02');
    expect(rows.map((r) => localTimeIn(r.startMs, PARIS))).toEqual(['09:00', '10:00']);
    expect(rows[0].cells.every((c) => c !== null)).toBe(true);
    expect(rows[1].cells[0]?.state).toBe('free');
    expect(rows[1].cells[1]).toBeNull();
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
    expect(rows[0].units.map((u) => localTimeIn(u.startMs, PARIS))).toEqual(['10:00']);
    expect(rows[1].units).toEqual([]);
  });
});
