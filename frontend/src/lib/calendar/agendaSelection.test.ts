import { describe, it, expect } from 'vitest';
import {
  defaultAgendaSelection,
  EMPTY_AGENDA_SELECTION,
  isAgendaSelected,
  campusSelectOptions,
  formationSelectOptions,
  hasAgendaSpace,
  isCampusWideReader,
} from './agendaSelection';
import { aggregatedCalendarFeedIcsPath } from '$lib/associations/api';

describe('defaultAgendaSelection', () => {
  it("starts from the reader's own campus and first known formation", () => {
    expect(
      defaultAgendaSelection({
        campus: 'gardanne',
        cursus: [
          { formation: 'Inconnue', promo: 2020 },
          { formation: 'ISMIN', promo: 2023 },
          { formation: 'ICM', promo: 2021 },
        ],
      })
    ).toEqual({ campus: 'gardanne', formation: 'ISMIN' });
  });

  it('invents nothing for a reader with no space: the choice stays required', () => {
    expect(defaultAgendaSelection(null)).toEqual(EMPTY_AGENDA_SELECTION);
    expect(defaultAgendaSelection({ campus: null, cursus: [] })).toEqual(EMPTY_AGENDA_SELECTION);
    expect(defaultAgendaSelection({ campus: 'mars' as never })).toEqual(EMPTY_AGENDA_SELECTION);
  });
});

describe('isAgendaSelected', () => {
  it('needs a campus or a formation, as the server does', () => {
    expect(isAgendaSelected(EMPTY_AGENDA_SELECTION)).toBe(false);
    expect(isAgendaSelected({ campus: 'gardanne', formation: '' })).toBe(true);
    expect(isAgendaSelected({ campus: '', formation: 'ICM' })).toBe(true);
  });
});

describe('options - ONLY the reader own spaces (user, 2026-10-06)', () => {
  const reader = {
    campus: 'gardanne',
    cursus: [
      { formation: 'ISMIN', promo: 2023 },
      { formation: 'ICM', promo: 2021 },
    ],
  } as const;

  it('offers the own campus and the own formations only, never "any"', () => {
    expect(
      campusSelectOptions({ ...reader, cursus: [...reader.cursus] }).map((o) => o.value)
    ).toEqual(['gardanne']);
    expect(
      formationSelectOptions({ ...reader, cursus: [...reader.cursus] }).map((o) => o.value)
    ).toEqual(['ICM', 'ISMIN']);
  });

  it('offers staff their own campus and "any formation" only, starting on the campus whole', () => {
    const staff = { campus: 'saint-etienne' as const, cursus: [], posts: ['EMSE' as const] };
    expect(campusSelectOptions(staff).map((o) => o.value)).toEqual(['saint-etienne']);
    expect(formationSelectOptions(staff).map((o) => o.value)).toEqual(['']);
    expect(defaultAgendaSelection(staff)).toEqual({ campus: 'saint-etienne', formation: '' });
    expect(isAgendaSelected(defaultAgendaSelection(staff))).toBe(true);
    expect(isCampusWideReader(staff)).toBe(true);
    expect(
      isCampusWideReader({ campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 1 }] })
    ).toBe(false);
  });

  it('makes staff a post EMSE or ME, never ALUMNI alone nor the lack of a cursus (2026-11-24)', () => {
    expect(isCampusWideReader({ campus: 'gardanne', cursus: [], posts: ['ME'] })).toBe(true);
    expect(isCampusWideReader({ campus: 'gardanne', cursus: [], posts: ['ALUMNI'] })).toBe(false);
    expect(isCampusWideReader({ campus: 'gardanne', cursus: [], posts: [] })).toBe(false);
    expect(isCampusWideReader({ campus: 'gardanne', cursus: [] })).toBe(false);
    // A student who is also staff keeps their own space.
    expect(
      isCampusWideReader({
        campus: 'gardanne',
        cursus: [{ formation: 'ICM', promo: 1 }],
        posts: ['EMSE'],
      })
    ).toBe(false);
  });

  it('offers nothing but "any" to a reader with no space, or before the profile loads', () => {
    expect(campusSelectOptions(null).map((o) => o.value)).toEqual(['']);
    expect(formationSelectOptions(null).map((o) => o.value)).toEqual(['']);
    expect(formationSelectOptions({ campus: 'gardanne', cursus: [] }).map((o) => o.value)).toEqual([
      '',
    ]);
  });

  it('says whether the reader has a space at all: both a campus and a known formation', () => {
    expect(hasAgendaSpace({ ...reader, cursus: [...reader.cursus] })).toBe(true);
    expect(hasAgendaSpace({ campus: 'gardanne', cursus: [], posts: ['EMSE'] })).toBe(true); // staff: campus whole
    expect(hasAgendaSpace({ campus: 'gardanne', cursus: [] })).toBe(false); // no space, no staff post
    expect(
      hasAgendaSpace({ campus: 'gardanne', cursus: [{ formation: 'X' as never, promo: 1 }] })
    ).toBe(false);
    expect(hasAgendaSpace({ campus: null, cursus: [] })).toBe(false);
    expect(hasAgendaSpace({ campus: null, cursus: null })).toBe(false);
    expect(hasAgendaSpace({ campus: null, cursus: [{ formation: 'ICM', promo: 2021 }] })).toBe(
      false
    );
    expect(hasAgendaSpace(null)).toBe(false);
  });
});

describe("one event's .ics path", () => {
  it('carries its window, its event and its signature', () => {
    const q = new URLSearchParams(
      aggregatedCalendarFeedIcsPath({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        eventId: 'ev1',
        sig: 'abc_-9',
      }).split('?')[1]
    );
    expect(q.get('eventId')).toBe('ev1');
    expect(q.get('sig')).toBe('abc_-9');
    expect(q.get('campus')).toBeNull();
  });
});
