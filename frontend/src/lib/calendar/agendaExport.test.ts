import { describe, expect, it } from 'vitest';
import { buildIcsCalendar, icsEscapeText, formatIcsUtc } from './agendaExport';

describe('icsEscapeText', () => {
  it('escapes RFC special characters', () => {
    expect(icsEscapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
});

describe('formatIcsUtc', () => {
  it('formats in UTC compact form', () => {
    expect(formatIcsUtc(new Date(Date.UTC(2026, 4, 13, 14, 30, 0)))).toBe('20260513T143000Z');
  });
});

describe('buildIcsCalendar', () => {
  it('includes one VEVENT with implied end', () => {
    const ics = buildIcsCalendar([
      {
        id: 'ev-1',
        title: 'Test « réunion »',
        description: 'Line1\nLine2',
        startsAt: '2026-05-13T12:00:00.000Z',
        endsAt: null,
      },
    ]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:ev-1@canari');
    expect(ics).toContain('SUMMARY:Test « réunion »');
    expect(ics).toContain('DESCRIPTION:Line1\\nLine2');
    expect(ics).toContain('DTSTART:20260513T120000Z');
    expect(ics).toMatch(/DTEND:20260513T130000Z/);
  });
});
