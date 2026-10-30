import { bookingNoticeMeta, noticePlace } from './booking-notifications.service';

describe('bookingNoticeMeta (the structured facts of a booking notice)', () => {
  const start = new Date('2026-11-03T09:00:00.000Z');

  it('carries the place, the slot start as a UTC instant, the space zone and the word', () => {
    expect(bookingNoticeMeta('Salle fermee', start, 'Europe/Paris', 'desole')).toEqual({
      place: 'Salle fermee',
      startsAt: '2026-11-03T09:00:00.000Z',
      timeZone: 'Europe/Paris',
      word: 'desole',
    });
  });

  it('leaves the place empty on a link-only space (Q-R5) but keeps the slot; no word is empty', () => {
    const place = noticePlace({ spaceName: 'Cabinet', discoverability: 'link', resourceName: 'X' });
    expect(bookingNoticeMeta(place, start, 'Europe/Paris')).toEqual({
      place: '',
      startsAt: '2026-11-03T09:00:00.000Z',
      timeZone: 'Europe/Paris',
      word: '',
    });
  });
});
