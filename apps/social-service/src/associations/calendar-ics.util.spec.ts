import { buildAggregatedCalendarIcs, organisersSummary } from './calendar-ics.util';

describe('organisersSummary', () => {
  it('names one or two, then counts the rest', () => {
    expect(organisersSummary(['A'])).toBe('A');
    expect(organisersSummary(['A', 'B'])).toBe('A + B');
    expect(organisersSummary(['A', 'B', 'C'])).toBe('A + 2 autres');
    expect(organisersSummary(['A', 'B', 'C', 'D'])).toBe('A + 3 autres');
  });
});

describe('buildAggregatedCalendarIcs', () => {
  const row = {
    id: 'e1',
    title: 'Soiree',
    description: null,
    startsAt: '2026-10-20T18:00:00.000Z',
    endsAt: null,
    associationName: 'Corpo',
    associationSlug: 'corpo',
  };

  it('keeps `title - owner` for a single-owner event', () => {
    const ics = buildAggregatedCalendarIcs([row], { frontendBaseUrl: 'http://x' });
    expect(ics).toContain('SUMMARY:Soiree - Corpo');
  });

  it('names every co-organiser the way the app does', () => {
    const ics = buildAggregatedCalendarIcs(
      [{ ...row, coOwners: [{ name: 'MiTV' }, { name: 'BDE' }] }],
      { frontendBaseUrl: 'http://x' }
    );
    expect(ics).toContain('SUMMARY:Soiree - Corpo + 2 autres');
  });
});
