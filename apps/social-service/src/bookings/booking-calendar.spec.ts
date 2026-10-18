import {
  bookingCalendarPath,
  bookingCalendarSignatureMatches,
  bookingIcs,
  canonicalBookingCalendar,
} from './booking-calendar';
import { canonicalAgendaSelection, signAgendaSelection } from '../associations/agenda-signature';

const ID = '11111111-2222-4333-8444-555555555555';
const sigOf = (path: string) => decodeURIComponent(path.split('sig=')[1]);

describe('a booking calendar link (D13)', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeEach(() => {
    process.env.AGENDA_SIGNING_KEY = 'k'.repeat(40);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  it('signs the booking id and accepts only that signature', () => {
    const sig = sigOf(bookingCalendarPath(ID));
    expect(bookingCalendarSignatureMatches(ID, sig)).toBe(true);
    expect(bookingCalendarSignatureMatches(ID.replace('1', '9'), sig)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, undefined)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, `${sig}x`)).toBe(false);
  });

  it('can never be read as an agenda selection, nor the other way round', () => {
    const agenda = { campus: null, formation: null, associationId: ID };
    expect(canonicalBookingCalendar(ID)).not.toBe(canonicalAgendaSelection(agenda));
    expect(bookingCalendarSignatureMatches(ID, signAgendaSelection(agenda))).toBe(false);
  });

  it('dies with the key: a rotation ends every saved link', () => {
    const sig = sigOf(bookingCalendarPath(ID));
    process.env.AGENDA_SIGNING_KEY = 'r'.repeat(40);
    expect(bookingCalendarSignatureMatches(ID, sig)).toBe(false);
  });

  it('refuses to sign with no key: a deployment fault, never an unsigned link', () => {
    delete process.env.AGENDA_SIGNING_KEY;
    expect(() => bookingCalendarPath(ID)).toThrow('Agenda signing is not configured');
  });

  it('writes the place, the range and a link back - nothing else', () => {
    const ics = bookingIcs({
      bookingId: ID,
      spaceId: 'space-1',
      spaceName: 'Salle de musique',
      resourceName: 'Piano',
      startsAt: new Date('2026-11-02T10:00:00Z'),
      endsAt: new Date('2026-11-02T10:30:00Z'),
      frontendBaseUrl: 'https://example.test/',
    });
    expect(ics).toContain(`UID:booking-${ID}@canari`);
    expect(ics).toContain('SUMMARY:Salle de musique - Piano');
    expect(ics).toContain('URL:https://example.test/bookings/spaces/space-1');
    expect(ics).not.toContain('DESCRIPTION');
  });
});
