import { describe, it, expect } from 'vitest';
import {
  defaultAgendaSelection,
  EMPTY_AGENDA_SELECTION,
  isAgendaSelected,
  campusSelectOptions,
  formationSelectOptions,
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

describe('options', () => {
  it('offers "any" first, then every value the server accepts', () => {
    expect(campusSelectOptions().map((o) => o.value)).toEqual(['', 'saint-etienne', 'gardanne']);
    expect(formationSelectOptions().map((o) => o.value)).toEqual([
      '',
      'ICM',
      'ISMIN',
      'FSSS',
      'PDIS',
      'Autre',
    ]);
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
});
