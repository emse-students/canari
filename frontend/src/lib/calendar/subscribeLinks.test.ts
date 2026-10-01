import { describe, it, expect } from 'vitest';
import { calendarAppSubscribeUrl, googleCalendarSubscribeUrl, isPhoneOs } from './subscribeLinks';

const FEED = 'https://canari.emse.fr/api/associations/calendar/feed.ics?associationId=7';

describe('calendarAppSubscribeUrl', () => {
  it('hands iOS the webcal scheme Calendar registers', () => {
    expect(calendarAppSubscribeUrl(FEED, 'ios')).toBe(
      'webcal://canari.emse.fr/api/associations/calendar/feed.ics?associationId=7'
    );
  });

  it('hands every other platform webcals, so a literal reader never meets a cross-scheme 301', () => {
    for (const os of ['android', 'windows', 'macos', 'linux', 'desktop']) {
      expect(calendarAppSubscribeUrl(FEED, os)).toBe(
        'webcals://canari.emse.fr/api/associations/calendar/feed.ics?associationId=7'
      );
    }
  });

  it('keeps a plain-http feed on plain webcal outside iOS', () => {
    expect(calendarAppSubscribeUrl('http://localhost:8081/feed.ics', 'android')).toBe(
      'webcal://localhost:8081/feed.ics'
    );
  });

  it('derives nothing before the feed URL exists', () => {
    expect(calendarAppSubscribeUrl('', 'ios')).toBe('');
  });
});

describe('googleCalendarSubscribeUrl', () => {
  it('passes the feed as http in cid, encoded', () => {
    expect(googleCalendarSubscribeUrl(FEED)).toBe(
      `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(
        'http://canari.emse.fr/api/associations/calendar/feed.ics?associationId=7'
      )}`
    );
    expect(googleCalendarSubscribeUrl('')).toBe('');
  });
});

describe('isPhoneOs', () => {
  it('names the two phone platforms and nothing else', () => {
    expect(isPhoneOs('android')).toBe(true);
    expect(isPhoneOs('ios')).toBe(true);
    expect(isPhoneOs('macos')).toBe(false);
    expect(isPhoneOs('web')).toBe(false);
  });
});
