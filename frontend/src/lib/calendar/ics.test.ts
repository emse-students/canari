import { describe, expect, it } from 'vitest';
import { buildIcsDocument, icsEndOrDefault, truncateIcsDescription } from './ics';

/**
 * These assert the rules the CLIENT and `social-service` must decide identically.
 *
 * The service carries a byte-identical copy of `ics.ts` (declared in
 * `.github/scripts/lib/declared-duplicates.mjs`), so proving them here proves them there - which
 * is the whole reason the file is copied rather than written twice.
 */
describe('icsEndOrDefault', () => {
  const start = new Date('2026-09-18T18:00:00Z');

  it('gives an event with no end one hour', () => {
    expect(icsEndOrDefault(start, null).toISOString()).toBe('2026-09-18T19:00:00.000Z');
    expect(icsEndOrDefault(start, undefined).toISOString()).toBe('2026-09-18T19:00:00.000Z');
  });

  it('treats an unreadable end and one that precedes the start as the same case', () => {
    expect(icsEndOrDefault(start, 'not a date').toISOString()).toBe('2026-09-18T19:00:00.000Z');
    expect(icsEndOrDefault(start, '2026-09-18T17:00:00Z').toISOString()).toBe(
      '2026-09-18T19:00:00.000Z'
    );
  });

  it('keeps a real end', () => {
    expect(icsEndOrDefault(start, '2026-09-20T14:00:00Z').toISOString()).toBe(
      '2026-09-20T14:00:00.000Z'
    );
  });
});

describe('truncateIcsDescription', () => {
  it('leaves a short description alone, trimmed', () => {
    expect(truncateIcsDescription('  hello  ')).toBe('hello');
  });

  it('cuts a long one and marks the cut', () => {
    const cut = truncateIcsDescription('x'.repeat(600));
    expect(cut).toHaveLength(451);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('buildIcsDocument', () => {
  const event = {
    uid: 'evt-1',
    summary: 'WEI',
    startsAt: '2026-09-18T16:00:00Z',
    endsAt: '2026-09-20T14:00:00Z',
  };

  it('writes UTC stamps in the RFC 5545 basic form', () => {
    const ics = buildIcsDocument([event]);
    expect(ics).toContain('DTSTART:20260918T160000Z');
    expect(ics).toContain('DTEND:20260920T140000Z');
    expect(ics).toContain('UID:evt-1@canari');
  });

  it('separates lines with CRLF, as the RFC requires', () => {
    expect(buildIcsDocument([event]).split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  });

  it('escapes the characters the RFC reserves in TEXT', () => {
    const ics = buildIcsDocument([{ ...event, summary: 'Gala, soiree; fin' }]);
    expect(ics).toContain('SUMMARY:Gala\\, soiree\\; fin');
  });

  it('omits DESCRIPTION and URL rather than writing an empty one', () => {
    const ics = buildIcsDocument([{ ...event, description: '   ', url: '  ' }]);
    expect(ics).not.toContain('DESCRIPTION:');
    expect(ics).not.toContain('URL:');
  });

  it('skips an event whose start cannot be read, and keeps the others', () => {
    const ics = buildIcsDocument([{ ...event, startsAt: 'not a date' }, event]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('still closes the calendar when every event was skipped', () => {
    const ics = buildIcsDocument([{ ...event, startsAt: 'not a date' }]);
    expect(ics.endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
