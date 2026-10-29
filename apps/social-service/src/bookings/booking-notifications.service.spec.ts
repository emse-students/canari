import { noticePlace, noticeRowText } from './booking-notifications.service';

describe('noticeRowText (the bell row of a booking notice)', () => {
  const start = new Date('2026-11-03T09:00:00.000Z');

  it('carries the place, the word and the slot start as three lines', () => {
    expect(noticeRowText('Salle fermee', 'desole', start)).toBe(
      'Salle fermee\ndesole\n2026-11-03T09:00:00.000Z'
    );
  });

  it('keeps the word on ONE line, so the layout cannot be shifted by its newlines', () => {
    const lines = noticeRowText('Salle', 'a\n\nb\r\n c', start).split('\n');
    expect(lines).toEqual(['Salle', 'a b c', '2026-11-03T09:00:00.000Z']);
  });

  it('leaves the place empty on a link-only space (Q-R5) and the word empty when none', () => {
    const place = noticePlace({ spaceName: 'Cabinet', discoverability: 'link', resourceName: 'X' });
    expect(noticeRowText(place, '', start)).toBe('\n\n2026-11-03T09:00:00.000Z');
  });
});
