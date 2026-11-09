import {
  bookingCalendarPath,
  bookingCalendarSignatureMatches,
  bookingIcs,
  canonicalBookingCalendar,
  MAX_RECIPIENT_LENGTH,
} from './booking-calendar';
import {
  assertAgendaSignature,
  canonicalAgendaSelection,
  signAgendaSelection,
} from '../associations/agenda-signature';

const ID = '11111111-2222-4333-8444-555555555555';
const ALICE = 'alice';
const BOB = 'bob';
const query = (path: string) => new URLSearchParams(path.split('?')[1]);
const sigOf = (path: string) => query(path).get('sig') ?? undefined;

describe('a booking calendar link (D13)', () => {
  const previous = process.env.AGENDA_SIGNING_KEY;
  beforeEach(() => {
    process.env.AGENDA_SIGNING_KEY = 'k'.repeat(40);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previous;
  });

  it('names its recipient and signs the booking with them', () => {
    const path = bookingCalendarPath(ID, ALICE);
    expect(query(path).get('u')).toBe(ALICE);
    const sig = sigOf(path);
    expect(bookingCalendarSignatureMatches(ID, ALICE, sig)).toBe(true);
    expect(bookingCalendarSignatureMatches(ID.replace('1', '9'), ALICE, sig)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, ALICE, undefined)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, ALICE, `${sig}x`)).toBe(false);
  });

  it('is bound to its recipient: another account, none, or an oversized one is refused', () => {
    const sig = sigOf(bookingCalendarPath(ID, ALICE));
    expect(bookingCalendarSignatureMatches(ID, BOB, sig)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, undefined, sig)).toBe(false);
    expect(bookingCalendarSignatureMatches(ID, 'a'.repeat(MAX_RECIPIENT_LENGTH + 1), sig)).toBe(
      false
    );
  });

  it('never lets a recipient containing the separator shift into the booking', () => {
    expect(canonicalBookingCalendar(ID, 'a|b')).not.toBe(canonicalBookingCalendar(`${ID}|a`, 'b'));
  });

  it('cannot be read as an agenda selection signature: an agenda signature is refused here', () => {
    const agenda = { campus: null, formation: null, associationId: ID };
    expect(canonicalBookingCalendar(ID, ALICE)).not.toBe(canonicalAgendaSelection(agenda));
    expect(bookingCalendarSignatureMatches(ID, ALICE, signAgendaSelection(agenda))).toBe(false);
  });

  it('and the other way round: a booking signature is refused as an agenda selection', () => {
    const sig = sigOf(bookingCalendarPath(ID, ALICE));
    for (const sel of [
      { campus: null, formation: null, associationId: ID },
      { campus: null, formation: null, associationId: null },
    ]) {
      expect(() => assertAgendaSignature(sel, sig)).toThrow(
        'The signature does not match this agenda selection'
      );
    }
  });

  it('dies with the key: a rotation ends every saved link', () => {
    const sig = sigOf(bookingCalendarPath(ID, ALICE));
    process.env.AGENDA_SIGNING_KEY = 'r'.repeat(40);
    expect(bookingCalendarSignatureMatches(ID, ALICE, sig)).toBe(false);
  });

  it('refuses to sign with no key: a deployment fault, never an unsigned link', () => {
    delete process.env.AGENDA_SIGNING_KEY;
    expect(() => bookingCalendarPath(ID, ALICE)).toThrow('Agenda signing is not configured');
  });

  it('writes the names of the place, the range and a link back - nothing else', () => {
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

  it("names the space alone for its hidden column (D44), never 'Salle - Salle'", () => {
    const ics = bookingIcs({
      bookingId: ID,
      spaceId: 'space-1',
      spaceName: 'Salle de musique',
      resourceName: 'Salle de musique',
      startsAt: new Date('2026-11-02T10:00:00Z'),
      endsAt: new Date('2026-11-02T10:30:00Z'),
      frontendBaseUrl: 'https://example.test/',
    });
    expect(ics).toMatch(/SUMMARY:Salle de musique\r?\n/);
  });
});
