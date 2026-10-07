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
    const staff = { campus: 'saint-etienne' as const, cursus: [] };
    expect(campusSelectOptions(staff).map((o) => o.value)).toEqual(['saint-etienne']);
    expect(formationSelectOptions(staff).map((o) => o.value)).toEqual(['']);
    expect(defaultAgendaSelection(staff)).toEqual({ campus: 'saint-etienne', formation: '' });
    expect(isAgendaSelected(defaultAgendaSelection(staff))).toBe(true);
    expect(isCampusWideReader(staff)).toBe(true);
    expect(
      isCampusWideReader({ campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 1 }] })
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
    expect(hasAgendaSpace({ campus: 'gardanne', cursus: [] })).toBe(true); // staff: campus whole
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

describe('the feed path carries the selection', () => {
  it('sends campus and formation only when chosen', () => {
    const base = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const q = new URLSearchParams(
      aggregatedCalendarFeedIcsPath({ ...base, campus: 'gardanne', formation: 'ICM' }).split('?')[1]
    );
    expect(q.get('campus')).toBe('gardanne');
    expect(q.get('formation')).toBe('ICM');
    const bare = aggregatedCalendarFeedIcsPath({ ...base, campus: '' as never, formation: null });
    expect(bare).not.toContain('campus');
    expect(bare).not.toContain('formation');
  });

  it('carries the signature, and only when there is one', () => {
    const base = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const signed = aggregatedCalendarFeedIcsPath({ ...base, campus: 'gardanne', sig: 'abc_-9' });
    expect(new URLSearchParams(signed.split('?')[1]).get('sig')).toBe('abc_-9');
    expect(aggregatedCalendarFeedIcsPath({ ...base, campus: 'gardanne' })).not.toContain('sig=');
  });
});
