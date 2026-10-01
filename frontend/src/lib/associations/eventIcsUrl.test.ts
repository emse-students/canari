import { describe, it, expect } from 'vitest';
import { eventIcsAbsoluteUrl } from './api';

describe('eventIcsAbsoluteUrl', () => {
  it('narrows the feed to one event, in a one-day window either side of its start', () => {
    const url = new URL(eventIcsAbsoluteUrl('ev 1', '2026-11-05T18:00:00.000Z'), 'https://x.test');
    expect(url.pathname).toBe('/api/associations/calendar/feed.ics');
    expect(url.searchParams.get('eventId')).toBe('ev 1');
    expect(url.searchParams.get('from')).toBe('2026-11-04T18:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-11-06T18:00:00.000Z');
  });

  it('yields nothing for an unreadable start rather than a guessed window', () => {
    expect(eventIcsAbsoluteUrl('ev1', 'not a date')).toBe('');
  });
});
