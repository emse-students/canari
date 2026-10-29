import { describe, it, expect } from 'vitest';
import { formatNoticeSlot, parseBookingNoticeText } from './noticeText';

describe('parseBookingNoticeText', () => {
  it('splits place, word and slot start', () => {
    expect(parseBookingNoticeText('Salle\ndesole\n2026-11-03T09:00:00.000Z')).toEqual({
      place: 'Salle',
      word: 'desole',
      startsAt: '2026-11-03T09:00:00.000Z',
    });
  });

  it('accepts an empty place (link-only space) and an empty word', () => {
    expect(parseBookingNoticeText('\n\n2026-11-03T09:00:00.000Z')).toEqual({
      place: '',
      word: '',
      startsAt: '2026-11-03T09:00:00.000Z',
    });
  });

  it('returns null for a row written before the slot was carried', () => {
    expect(parseBookingNoticeText('Salle de musique')).toBeNull();
    expect(parseBookingNoticeText('')).toBeNull();
    expect(parseBookingNoticeText('a\nb\nnot a date')).toBeNull();
  });
});

describe('formatNoticeSlot', () => {
  it('names the day and the start time', () => {
    const text = formatNoticeSlot('2026-11-03T09:00:00.000Z');
    expect(text).toMatch(/3/);
    expect(text).toMatch(/\d{2}:\d{2}/);
  });
});
