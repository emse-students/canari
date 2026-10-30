import {
  BookingNotificationsService,
  bookingNoticeMeta,
  noticePlace,
  reminderAssociation,
} from './booking-notifications.service';

describe('the association a reminder shows (owner, 2026-10-30)', () => {
  const facts = {
    discoverability: 'listed',
    associationId: 'asso-1',
    associationName: 'Club Musique',
    associationLogoUrl: '/api/media/public/logo1',
  };

  it('is the space owner, with its logo', () => {
    expect(reminderAssociation(facts)).toEqual({
      id: 'asso-1',
      name: 'Club Musique',
      logoUrl: '/api/media/public/logo1',
    });
  });

  it('is nobody on a link-only space (Q-R5), a personal space, or a vanished association', () => {
    expect(reminderAssociation({ ...facts, discoverability: 'link' })).toBeNull();
    expect(reminderAssociation({ ...facts, associationId: null })).toBeNull();
    expect(reminderAssociation({ ...facts, associationName: null })).toBeNull();
  });

  it('rides the bell row as associationId and logo, and stays the platform without one', async () => {
    const createNotification = jest.fn();
    const service = new BookingNotificationsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { createNotification } as never
    );
    await service.remind('u1', 'b1', 'Salle · 11:00', reminderAssociation(facts));
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      type: 'booking_reminder',
      actorName: 'Club Musique',
      associationId: 'asso-1',
      associationLogoUrl: '/api/media/public/logo1',
    });
    await service.remind('u1', 'b2', '11:00');
    expect(createNotification.mock.calls[1][0].associationId).toBeUndefined();
    expect(createNotification.mock.calls[1][0].actorName).toBe('Canari');
  });
});

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
