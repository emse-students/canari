/**
 * THE DAY AN EVENT BELONGS TO IS A QUESTION ABOUT THE READER'S MIDNIGHT, NOT ABOUT UTC.
 *
 * These pin the two things a calendar gets wrong quietly: a multi-day event that only shows on the
 * day it started, and a month whose last day is computed rather than asked for. Both are invisible
 * until a specific date, which is why they are pinned rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import {
  dayOccupancy,
  eventCardsOnDay,
  eventCoversDay,
  eventsOnDay,
  groupEventsByDayInRange,
  formatEventTimeRange,
  eventAccentColor,
  eventOwners,
  eventOwnersLabel,
} from './feedEvents';

/** Local-time ISO, so the test says the same thing wherever it runs. */
function localIso(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function event(partial: Partial<AssociationCalendarFeedEvent>): AssociationCalendarFeedEvent {
  return {
    id: 'e1',
    title: 'Event',
    startsAt: localIso(2026, 9, 9, 18),
    endsAt: null,
    associationId: 'a1',
    associationName: 'BDE',
    associationSlug: 'bde',
    associationColor: null,
    associationLogoUrl: null,
    ...partial,
  } as AssociationCalendarFeedEvent;
}

describe('eventCoversDay', () => {
  it('places a point-in-time event on the day it starts, in local time', () => {
    const ev = event({ startsAt: localIso(2026, 9, 9, 18) });

    expect(eventCoversDay(ev, new Date(2026, 8, 9))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 10))).toBe(false);
  });

  it('covers EVERY day a multi-day event spans, not just its first', () => {
    // A three-day weekend: the reader asking "what is on Saturday" must see it on Saturday.
    // It ENDS at 02:00 on the 13th, which is still the night of the 12th, so the 13th is not one
    // of its days - see "a calendar day begins at 05:00" below.
    const ev = event({ startsAt: localIso(2026, 9, 11, 18), endsAt: localIso(2026, 9, 13, 2) });

    expect(eventCoversDay(ev, new Date(2026, 8, 10))).toBe(false);
    expect(eventCoversDay(ev, new Date(2026, 8, 11))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 12))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 13))).toBe(false);
    expect(eventCoversDay(ev, new Date(2026, 8, 14))).toBe(false);
  });

  it('does not spill onto the next square when it ends one minute past midnight', () => {
    // The comparison is between DAYS, and a day now ends at 05:00: an evening running to 00:01 is
    // still ONE evening. This asserted the opposite until 2026-09-16, which is the defect - the
    // grid drew a second square for a night that had already finished.
    const ev = event({ startsAt: localIso(2026, 9, 11, 22), endsAt: localIso(2026, 9, 12, 0, 1) });

    expect(eventCoversDay(ev, new Date(2026, 8, 11))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 12))).toBe(false);
  });
});

describe('eventsOnDay', () => {
  it('orders by start time rather than by the order the feed returned', () => {
    const late = event({ id: 'late', startsAt: localIso(2026, 9, 9, 21) });
    const early = event({ id: 'early', startsAt: localIso(2026, 9, 9, 8) });

    const on = eventsOnDay([late, early], new Date(2026, 8, 15), 9);

    expect(on.map((e) => e.id)).toEqual(['early', 'late']);
  });
});

describe('groupEventsByDayInRange', () => {
  /** A whole month, which is the shape the grid asks for and one range among many. */
  function month(year: number, monthIndex: number): [Date, Date] {
    return [new Date(year, monthIndex, 1), new Date(year, monthIndex + 1, 0)];
  }

  it('returns one group per day that has events, and no empty days', () => {
    const groups = groupEventsByDayInRange(
      [
        event({ id: 'a', startsAt: localIso(2026, 9, 3, 12) }),
        event({ id: 'b', startsAt: localIso(2026, 9, 20, 12) }),
        event({ id: 'c', startsAt: localIso(2026, 9, 3, 19) }),
      ],
      ...month(2026, 8)
    );

    // Three events on two days: a schedule is a list of what is happening, not thirty blank rows.
    expect(groups.map((g) => g.day)).toEqual([3, 20]);
    expect(groups[0].events.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('reaches the last day of the month, including one that has 31', () => {
    const groups = groupEventsByDayInRange(
      [event({ id: 'nye', startsAt: localIso(2026, 12, 31, 22) })],
      ...month(2026, 11)
    );

    expect(groups.map((g) => g.day)).toEqual([31]);
  });

  it('ignores events outside the range', () => {
    const groups = groupEventsByDayInRange(
      [event({ startsAt: localIso(2026, 10, 2, 12) })],
      ...month(2026, 8)
    );

    expect(groups).toEqual([]);
  });

  it('repeats a multi-day event on each of its days', () => {
    const groups = groupEventsByDayInRange(
      [event({ id: 'wei', startsAt: localIso(2026, 9, 5, 8), endsAt: localIso(2026, 9, 7, 18) })],
      ...month(2026, 8)
    );

    expect(groups.map((g) => g.day)).toEqual([5, 6, 7]);
  });

  /**
   * THE PHONE'S WINDOW IS NOT A MONTH, and these are the two things that used to be impossible to
   * express: a start that is not the 1st, and an end in another month.
   */
  it('starts on the day it was given, not on the first of its month', () => {
    const groups = groupEventsByDayInRange(
      [
        event({ id: 'past', startsAt: localIso(2026, 9, 3, 12) }),
        event({ id: 'today', startsAt: localIso(2026, 9, 28, 12) }),
      ],
      new Date(2026, 8, 28),
      new Date(2026, 8, 30)
    );

    expect(groups.map((g) => g.events[0].id)).toEqual(['today']);
  });

  it('crosses a month boundary, and the day numbers restart rather than continue', () => {
    const groups = groupEventsByDayInRange(
      [
        event({ id: 'sep', startsAt: localIso(2026, 9, 30, 12) }),
        event({ id: 'oct', startsAt: localIso(2026, 10, 1, 12) }),
      ],
      new Date(2026, 8, 28),
      new Date(2026, 10, 30)
    );

    expect(groups.map((g) => g.day)).toEqual([30, 1]);
    expect(groups.map((g) => g.date.getMonth())).toEqual([8, 9]);
  });

  it('keeps a multi-day event on every day of its own that the window covers', () => {
    // It began before the window opened - the server returns it, because its range predicate is an
    // overlap - and the days it still covers are the reader's answer to "what is on today".
    const groups = groupEventsByDayInRange(
      [
        event({
          id: 'wei',
          startsAt: localIso(2026, 9, 25, 18),
          endsAt: localIso(2026, 10, 2, 12),
        }),
      ],
      new Date(2026, 8, 28),
      new Date(2026, 9, 31)
    );

    expect(groups.map((g) => [g.date.getMonth(), g.day])).toEqual([
      [8, 28],
      [8, 29],
      [8, 30],
      [9, 1],
      [9, 2],
    ]);
  });

  it('draws nothing when the window ends before it starts', () => {
    expect(
      groupEventsByDayInRange(
        [event({ startsAt: localIso(2026, 9, 28, 12) })],
        new Date(2026, 8, 28),
        new Date(2026, 8, 27)
      )
    ).toEqual([]);
  });
});

describe('formatEventTimeRange', () => {
  it('gives one time for an event with no end', () => {
    expect(formatEventTimeRange(event({ startsAt: localIso(2026, 9, 9, 18, 30) }))).toBe('18:30');
  });

  it('gives a range for an event with one', () => {
    expect(
      formatEventTimeRange(
        event({ startsAt: localIso(2026, 9, 9, 18, 0), endsAt: localIso(2026, 9, 9, 20, 30) })
      )
    ).toBe('18:00 - 20:30');
  });
});

describe('eventAccentColor', () => {
  it("uses the association's own colour when it has set one", () => {
    expect(eventAccentColor(event({ associationColor: '#ff8800' }))).toBe('#ff8800');
  });

  it('falls back to a colour derived from the id, stable across calls', () => {
    const ev = event({ associationColor: null, associationId: 'bde' });

    const first = eventAccentColor(ev);

    expect(first).toMatch(/^#[0-9a-f]{6}$/i);
    expect(eventAccentColor(ev)).toBe(first);
  });
});

describe('eventOwners', () => {
  /**
   * THE CRASH THIS PINS. `/associations/mitv` asked for MiTV's month, got back an event MiTV only
   * CO-OWNS, and the page stamped itself onto it as the owner - so MiTV stood in the owner slot and
   * the co-owner slot of the same event. The grid keys its logo bands on that list, two entries
   * collided, and Svelte threw `each_key_duplicate`: not a logo painted wrong, the whole page gone
   * (production, 2026-09-14).
   */
  it('names the event OWNER first, then the co-owners', () => {
    const owners = eventOwners(
      event({
        associationId: 'corpo-id',
        associationName: 'Corpo',
        associationSlug: 'corpo',
        coOwners: [
          { associationId: 'mitv-id', name: 'MiTV', slug: 'mitv', color: '#111', logoUrl: '/l' },
        ],
      })
    );

    expect(owners.map((o) => o.associationId)).toEqual(['corpo-id', 'mitv-id']);
    expect(owners[0].name).toBe('Corpo');
    expect(owners[1].logoUrl).toBe('/l');
  });

  it('gives every entry a distinct key even when two associations share a name', () => {
    const owners = eventOwners(
      event({
        associationId: 'a-id',
        associationName: 'Club',
        coOwners: [
          { associationId: 'b-id', name: 'Club', slug: 'club-2', color: null, logoUrl: null },
        ],
      })
    );

    const keys = owners.map((o) => o.associationId);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is the owner alone when nothing is co-owned', () => {
    expect(eventOwners(event({ coOwners: [] })).map((o) => o.associationId)).toEqual(['a1']);
  });
});

describe('eventOwnersLabel', () => {
  const shared = event({
    associationId: 'corpo-id',
    associationName: 'Corpo',
    coOwners: [
      { associationId: 'mitv-id', name: 'MiTV', slug: 'mitv', color: null, logoUrl: null },
    ],
  });

  it('names every association running the event, owner first', () => {
    expect(eventOwnersLabel(shared)).toBe('Corpo + MiTV');
  });

  it('still names both on the page of one of them - that it is shared is the point', () => {
    expect(eventOwnersLabel(shared, 'mitv-id')).toBe('Corpo + MiTV');
    expect(eventOwnersLabel(shared, 'corpo-id')).toBe('Corpo + MiTV');
  });

  it('says nothing only when the page owns the event alone', () => {
    const solo = event({ associationId: 'mitv-id', associationName: 'MiTV', coOwners: [] });
    expect(eventOwnersLabel(solo, 'mitv-id')).toBe('');
    expect(eventOwnersLabel(solo, 'corpo-id')).toBe('MiTV');
    expect(eventOwnersLabel(solo)).toBe('MiTV');
  });
});

describe('a calendar day begins at 05:00, not at midnight', () => {
  /**
   * THE CASE THE RULE WAS WRITTEN FOR. A party announced 23:00-02:00 is one evening, and midnight
   * used to cut it in two - the second square claiming an event on a morning when nothing happens.
   */
  it('keeps a 23:00-02:00 party on ONE square, the evening it started', () => {
    const party = event({
      startsAt: localIso(2026, 9, 4, 23),
      endsAt: localIso(2026, 9, 5, 2),
    });

    expect(eventCoversDay(party, new Date(2026, 8, 4))).toBe(true);
    expect(eventCoversDay(party, new Date(2026, 8, 5))).toBe(false);
  });

  it('assigns the small hours to the evening before', () => {
    const lateNight = event({ startsAt: localIso(2026, 9, 5, 2), endsAt: null });

    expect(eventCoversDay(lateNight, new Date(2026, 8, 4))).toBe(true);
    expect(eventCoversDay(lateNight, new Date(2026, 8, 5))).toBe(false);
  });

  it('puts the boundary itself on the new day, and the minute before on the old one', () => {
    const onIt = event({ startsAt: localIso(2026, 9, 5, 5, 0), endsAt: null });
    const justBefore = event({ startsAt: localIso(2026, 9, 5, 4, 59), endsAt: null });

    expect(eventCoversDay(onIt, new Date(2026, 8, 5))).toBe(true);
    expect(eventCoversDay(justBefore, new Date(2026, 8, 5))).toBe(false);
    expect(eventCoversDay(justBefore, new Date(2026, 8, 4))).toBe(true);
  });

  /**
   * THE REGRESSION THAT WOULD MOVE EVERY EVENT BACK A DAY. `eventCoversDay`'s two arguments are not
   * the same kind of thing - one is an instant to be assigned, the other is a square that already
   * IS a day - and shifting both by five hours is an easy way to apply the rule twice. An ordinary
   * daytime event is what notices.
   */
  it('does not shift the square as well, so an ordinary daytime event stays put', () => {
    const lecture = event({ startsAt: localIso(2026, 9, 5, 10), endsAt: localIso(2026, 9, 5, 12) });

    expect(eventCoversDay(lecture, new Date(2026, 8, 5))).toBe(true);
    expect(eventCoversDay(lecture, new Date(2026, 8, 4))).toBe(false);
    expect(eventsOnDay([lecture], new Date(2026, 8, 1), 5)).toHaveLength(1);
  });

  it('still spans every square of a genuinely multi-day event', () => {
    const weekend = event({
      startsAt: localIso(2026, 9, 4, 20),
      endsAt: localIso(2026, 9, 6, 23),
    });

    expect([3, 4, 5, 6, 7].map((d) => eventCoversDay(weekend, new Date(2026, 8, d)))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('dayOccupancy - how much of ONE day an event fills', () => {
  /**
   * THE DEFECT A WEI EXPOSED, AND THE REASON THIS FUNCTION EXISTS.
   *
   * The half-cell rule used to read `startsAt.getHours()` on every square a multi-day event
   * covered, so a Friday 18:00 departure painted the BOTTOM half of Saturday and of Sunday - two
   * days the event holds end to end, and about which its start hour says nothing at all.
   */
  const wei = event({
    startsAt: localIso(2026, 9, 18, 18),
    endsAt: localIso(2026, 9, 20, 17),
  });

  it('halves the first day, which the event only holds from the evening', () => {
    expect(dayOccupancy(wei, new Date(2026, 8, 18))).toBe('afternoon');
  });

  it('FILLS a day the event holds end to end', () => {
    expect(dayOccupancy(wei, new Date(2026, 8, 19))).toBe('full');
  });

  it('fills the last day too when the event runs past the pivot hour', () => {
    expect(dayOccupancy(wei, new Date(2026, 8, 20))).toBe('full');
  });

  it('leaves the last day a morning when the event ends before the pivot', () => {
    const earlyFinish = event({
      startsAt: localIso(2026, 9, 18, 18),
      endsAt: localIso(2026, 9, 20, 11),
    });

    expect(dayOccupancy(earlyFinish, new Date(2026, 8, 20))).toBe('morning');
  });

  /**
   * A DEPARTURE BEFORE THE PIVOT LEAVES NO FREE HALF EITHER. The event holds the day from the
   * morning to 05:00 tomorrow, so halving it would claim an empty afternoon that is not empty.
   */
  it('fills the first day when the event leaves in the morning', () => {
    const morningDeparture = event({
      startsAt: localIso(2026, 9, 18, 9),
      endsAt: localIso(2026, 9, 20, 17),
    });

    expect(dayOccupancy(morningDeparture, new Date(2026, 8, 18))).toBe('full');
  });

  it('keeps the original rule for an event contained in its day', () => {
    const lecture = event({
      startsAt: localIso(2026, 9, 18, 9),
      endsAt: localIso(2026, 9, 18, 11),
    });
    const party = event({ startsAt: localIso(2026, 9, 18, 23), endsAt: localIso(2026, 9, 19, 2) });

    expect(dayOccupancy(lecture, new Date(2026, 8, 18))).toBe('morning');
    expect(dayOccupancy(party, new Date(2026, 8, 18))).toBe('afternoon');
  });

  it('reads a point in time by its own hour', () => {
    const noEnd = event({ startsAt: localIso(2026, 9, 18, 15), endsAt: null });

    expect(dayOccupancy(noEnd, new Date(2026, 8, 18))).toBe('afternoon');
  });

  /**
   * A DAY AN EVENT HOLDS ACROSS THE PIVOT HAS NO FREE HALF, and until 2026-09-23 the contained case
   * never asked: it named the half its START hour fell in, so `Forum Perspectives` 08:00-18:00 was
   * drawn as a morning with an afternoon that was not free. Reported by the user against the
   * October sheet, where `Interpromos` and `Trams` did the same thing.
   */
  it('FILLS a day an event contained in it holds across the pivot', () => {
    const forum = event({
      startsAt: localIso(2026, 9, 20, 8),
      endsAt: localIso(2026, 9, 20, 18),
    });

    expect(dayOccupancy(forum, new Date(2026, 8, 20))).toBe('full');
  });

  it('fills when the event reaches the pivot exactly, and halves one minute short of it', () => {
    const toThePivot = event({
      startsAt: localIso(2026, 9, 20, 9),
      endsAt: localIso(2026, 9, 20, 13),
    });
    const justBefore = event({
      startsAt: localIso(2026, 9, 20, 9),
      endsAt: localIso(2026, 9, 20, 12, 59),
    });

    expect(dayOccupancy(toThePivot, new Date(2026, 8, 20))).toBe('full');
    expect(dayOccupancy(justBefore, new Date(2026, 8, 20))).toBe('morning');
  });

  /**
   * AN HOUR PAST MIDNIGHT IS NOT AN EARLY HOUR, it is a late one on a day that is not over - which
   * is the whole of {@link DAY_STARTS_AT_HOUR}. Compared raw against the pivot, 02:00 read as 2 and
   * claimed a morning: a trip leaving Friday 18:00 and returning Sunday 02:00 answered `morning`
   * for its SATURDAY, a day it holds from end to end.
   */
  it('fills the middle day of a trip that returns after midnight', () => {
    const trip = event({
      startsAt: localIso(2026, 9, 18, 18),
      endsAt: localIso(2026, 9, 20, 2),
    });

    expect(dayOccupancy(trip, new Date(2026, 8, 19))).toBe('full');
  });
});

describe('eventCardsOnDay - the selector both painted surfaces now share', () => {
  /**
   * THE SECOND HALF OF THE 2026-09-16 DEFECT. `MonthCalendarGridRich` and `calendarExport` each
   * held a private copy splitting the month at MIDNIGHT, and neither was changed when the 05:00
   * boundary landed - so the two surfaces a user actually looks at went on drawing a 23:00-02:00
   * evening twice. This asserts the selector they now call applies the boundary.
   */
  it('keeps a 23:00-02:00 party off the following square', () => {
    const party = event({
      startsAt: localIso(2026, 9, 4, 23),
      endsAt: localIso(2026, 9, 5, 2),
    });
    const focus = new Date(2026, 8, 1);

    expect(eventCardsOnDay([party], focus, 4)).toHaveLength(1);
    expect(eventCardsOnDay([party], focus, 5)).toHaveLength(0);
  });

  it('leaves break entries to the background band', () => {
    const holiday = event({ startsAt: localIso(2026, 9, 4, 9), kind: 'break' });
    const lecture = event({ startsAt: localIso(2026, 9, 4, 9) });

    expect(eventCardsOnDay([holiday, lecture], new Date(2026, 8, 1), 4)).toEqual([lecture]);
  });
});
