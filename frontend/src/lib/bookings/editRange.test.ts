import { describe, expect, it } from 'vitest';
import type { BookerSpace, BookingView, SlotUnit } from './api';
import { editChoices, editPeople, unitsFreedFor } from './editRange';

const DAY = '2026-11-02';
const HALF = 30 * 60_000;
const START = Date.parse(`${DAY}T08:00:00Z`);
const at = (i: number) => START + i * HALF;

const view = (id: string, i: number, n = 1): BookingView => ({
  id,
  resourceId: 'r1',
  startsAt: new Date(at(i)).toISOString(),
  endsAt: new Date(at(i + n)).toISOString(),
  cancelled: false,
  mine: id === 'mine',
});

/** Eight half-hour units from 08:00 UTC: free, except where `taken` says whose booking holds one. */
function units(taken: Record<number, BookingView> = {}, day = DAY): SlotUnit[] {
  const base = Date.parse(`${day}T08:00:00Z`);
  return Array.from({ length: 8 }, (_, i) => {
    const u = { date: day, startMs: base + i * HALF, endMs: base + (i + 1) * HALF };
    return taken[i]
      ? ({ ...u, state: 'booked', booking: taken[i] } as SlotUnit)
      : ({ ...u, state: 'free' } as SlotUnit);
  });
}

const space = {
  timeZone: 'UTC',
  slotMode: 'step',
  maxSteps: 4,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
} as unknown as BookerSpace;
const NOW = Date.parse('2026-11-01T12:00:00Z');

describe('unitsFreedFor', () => {
  it("reads the edited booking's own units as free, and nobody else's", () => {
    const own = view('mine', 2, 2);
    const other = view('other', 5);
    const freed = unitsFreedFor(units({ 2: own, 3: own, 5: other }), 'mine');
    expect(freed.map((u) => u.state)).toEqual([
      'free',
      'free',
      'free',
      'free',
      'free',
      'booked',
      'free',
      'free',
    ]);
  });
});

describe('editChoices', () => {
  it('opens on the booking itself: its start, and its length counted in units', () => {
    const own = view('mine', 2, 2);
    const choices = editChoices(units({ 2: own, 3: own }), own, space, NOW, null)!;
    expect(choices.starts[choices.startIndex].startMs).toBe(at(2));
    expect(choices.count).toBe(2);
  });

  it('lets the range grow over its own units and the free ones, up to the next taken unit', () => {
    const own = view('mine', 2, 2);
    const choices = editChoices(
      units({ 2: own, 3: own, 5: view('other', 5) }),
      own,
      space,
      NOW,
      null
    )!;
    // From its own start: 10:00..11:00 are its own, 11:00 is free, 11:30 is someone else's.
    expect(choices.runOf(choices.starts[choices.startIndex]).map((u) => u.startMs)).toEqual([
      at(2),
      at(3),
      at(4),
    ]);
    // Someone else's unit is never a start.
    expect(choices.starts.map((u) => u.startMs)).not.toContain(at(5));
  });

  it("offers no start the booking window refuses, but always the booking's own", () => {
    const own = view('mine', 2);
    // 08:45: a 60-minute notice refuses every start before 09:45 - the booking's own 09:00 stays.
    const late = Date.parse(`${DAY}T08:45:00Z`);
    const strict = { ...space, minNoticeMinutes: 60 } as BookerSpace;
    const choices = editChoices(units({ 2: own }), own, strict, late, null)!;
    expect(choices.starts.map((u) => u.startMs)).toEqual([at(2), at(4), at(5), at(6), at(7)]);
  });

  it('offers a later start inside its own range despite the window, as giving back only', () => {
    // 09:00-10:00 at 08:45: the 60-minute notice refuses 09:30, yet a start there only gives back
    // (review of #2945) - offered, and running no further than the booking's own end.
    const own = view('mine', 2, 2);
    const late = Date.parse(`${DAY}T08:45:00Z`);
    const strict = { ...space, minNoticeMinutes: 60 } as BookerSpace;
    const choices = editChoices(units({ 2: own, 3: own }), own, strict, late, null)!;
    expect(choices.starts.map((u) => u.startMs)).toEqual([
      at(2),
      at(3),
      at(4),
      at(5),
      at(6),
      at(7),
    ]);
    const later = choices.starts.find((u) => u.startMs === at(3))!;
    expect(choices.runOf(later).map((u) => u.startMs)).toEqual([at(3)]);
    // Its own start keeps any length: the window never reads a start that did not move.
    const ownRun = choices.runOf(choices.starts[choices.startIndex]);
    expect(ownRun.map((u) => u.startMs)).toEqual([at(2), at(3), at(4), at(5)]);
  });

  it("offers only the booking's own day", () => {
    const own = view('mine', 2);
    const nextDay = units({}, '2026-11-03');
    const choices = editChoices([...units({ 2: own }), ...nextDay], own, space, NOW, null)!;
    expect(choices.starts.every((u) => new Date(u.startMs).toISOString().startsWith(DAY))).toBe(
      true
    );
  });

  it('is null when the week held does not hold the booking', () => {
    // The week moved on: the read holds another day, not the booking's own start.
    expect(editChoices(units({}, '2026-11-09'), view('mine', 2), space, NOW, null)).toBeNull();
  });
});

describe('editPeople', () => {
  const booking = {
    holderId: 'holder',
    others: [
      { id: 'holder', name: 'Holder' },
      { id: 'bob', name: 'Bob' },
      { id: '', name: 'Compte supprimé' },
    ],
  };

  it('is the participants the reader sees, the holder and an erased account left out', () => {
    expect(editPeople(booking, { id: 'orga', isParticipant: false }, 'Vous')).toEqual([
      { id: 'bob', displayName: 'Bob' },
    ]);
  });

  it('puts back a reader who is one of the participants, so the edit does not remove them', () => {
    expect(editPeople(booking, { id: 'orga', isParticipant: true }, 'Vous')).toEqual([
      { id: 'orga', displayName: 'Vous' },
      { id: 'bob', displayName: 'Bob' },
    ]);
  });
});
