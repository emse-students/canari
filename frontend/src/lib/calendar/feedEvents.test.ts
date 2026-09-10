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
  eventCoversDay,
  eventsOnDay,
  groupMonthEventsByDay,
  formatEventTimeRange,
  eventAccentColor,
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
    const ev = event({ startsAt: localIso(2026, 9, 11, 18), endsAt: localIso(2026, 9, 13, 2) });

    expect(eventCoversDay(ev, new Date(2026, 8, 10))).toBe(false);
    expect(eventCoversDay(ev, new Date(2026, 8, 11))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 12))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 13))).toBe(true);
    expect(eventCoversDay(ev, new Date(2026, 8, 14))).toBe(false);
  });

  it('covers the whole of its last day even when it ends one minute past midnight', () => {
    // The comparison is between DAYS, not instants: an end of 00:01 still means that day is used.
    const ev = event({ startsAt: localIso(2026, 9, 11, 22), endsAt: localIso(2026, 9, 12, 0, 1) });

    expect(eventCoversDay(ev, new Date(2026, 8, 12))).toBe(true);
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

describe('groupMonthEventsByDay', () => {
  it('returns one group per day that has events, and no empty days', () => {
    const groups = groupMonthEventsByDay(
      [
        event({ id: 'a', startsAt: localIso(2026, 9, 3, 12) }),
        event({ id: 'b', startsAt: localIso(2026, 9, 20, 12) }),
        event({ id: 'c', startsAt: localIso(2026, 9, 3, 19) }),
      ],
      new Date(2026, 8, 15)
    );

    // Three events on two days: a schedule is a list of what is happening, not thirty blank rows.
    expect(groups.map((g) => g.day)).toEqual([3, 20]);
    expect(groups[0].events.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('reaches the last day of the month, including one that has 31', () => {
    const groups = groupMonthEventsByDay(
      [event({ id: 'nye', startsAt: localIso(2026, 12, 31, 22) })],
      new Date(2026, 11, 1)
    );

    expect(groups.map((g) => g.day)).toEqual([31]);
  });

  it('ignores events belonging to another month', () => {
    const groups = groupMonthEventsByDay(
      [event({ startsAt: localIso(2026, 10, 2, 12) })],
      new Date(2026, 8, 15)
    );

    expect(groups).toEqual([]);
  });

  it('repeats a multi-day event on each of its days', () => {
    const groups = groupMonthEventsByDay(
      [event({ id: 'wei', startsAt: localIso(2026, 9, 5, 8), endsAt: localIso(2026, 9, 7, 18) })],
      new Date(2026, 8, 1)
    );

    expect(groups.map((g) => g.day)).toEqual([5, 6, 7]);
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
