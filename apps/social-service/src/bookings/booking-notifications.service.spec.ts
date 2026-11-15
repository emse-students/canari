import {
  BookingNotificationsService,
  bookingNoticeMeta,
  noticePlace,
  reminderAssociation,
  reminderLine,
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

  it('is nobody on a link-only space (Q-R5), or a personal space', () => {
    expect(reminderAssociation({ ...facts, discoverability: 'link' })).toBeNull();
    expect(reminderAssociation({ ...facts, associationId: null })).toBeNull();
  });

  it('keeps the row when the association has no name yet, drawn under the platform name', async () => {
    expect(reminderAssociation({ ...facts, associationName: null })).toMatchObject({
      id: 'asso-1',
      name: '',
    });
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

describe('reminderLine (the push body of a reminder, 2026-11-15)', () => {
  const facts = {
    spaceName: 'Salle de musique',
    discoverability: 'listed',
    resourceName: 'Salle de musique',
  };
  const start = new Date('2026-11-16T13:00:00.000Z'); // 14:00 in Paris

  it('is the time alone-after-place when the reminder goes out the same local day', () => {
    expect(reminderLine(facts, start, 'Europe/Paris', new Date('2026-11-16T12:00:00.000Z'))).toBe(
      'Salle de musique · 14:00'
    );
  });

  it('leads with the date when a day-before reminder goes out the day before', () => {
    expect(reminderLine(facts, start, 'Europe/Paris', new Date('2026-11-15T13:00:00.000Z'))).toBe(
      'Salle de musique · 16/11 14:00'
    );
  });

  it('judges the day on the SPACE clock, not UTC', () => {
    // 23:30 UTC on the 15th is already the 16th in Paris: same local day as a 14:00 slot.
    expect(reminderLine(facts, start, 'Europe/Paris', new Date('2026-11-15T23:30:00.000Z'))).toBe(
      'Salle de musique · 14:00'
    );
  });

  it('is the date and time alone on a link-only space (Q-R5)', () => {
    const link = { ...facts, discoverability: 'link' };
    expect(reminderLine(link, start, 'Europe/Paris', new Date('2026-11-15T13:00:00.000Z'))).toBe(
      '16/11 14:00'
    );
  });
});
