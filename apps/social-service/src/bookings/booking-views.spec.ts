import {
  bookingView,
  privateInfoFor,
  relationTo,
  type BookingRow,
  type ParticipantRow,
} from './booking-views';

const HOLDER = 'h'.repeat(64);
const IN = 'i'.repeat(64);
const OUT = 'o'.repeat(64);
const STRANGER = 's'.repeat(64);

const booking: BookingRow = {
  id: 'b1',
  resourceId: 'r1',
  holderId: HOLDER,
  holderName: 'Holder',
  startsAt: new Date('2026-11-02T10:00:00Z'),
  endsAt: new Date('2026-11-02T10:30:00Z'),
  cancelledAt: null,
  answers: { q: 'secret' },
};
const people: ParticipantRow[] = [
  { bookingId: 'b1', userId: IN, userName: 'In', withdrawnAt: null },
  { bookingId: 'b1', userId: OUT, userName: 'Out', withdrawnAt: new Date() },
  { bookingId: 'other', userId: STRANGER, userName: 'Elsewhere', withdrawnAt: null },
];

describe('relationTo', () => {
  it.each([
    [HOLDER, false, 'people'],
    [IN, false, 'people'],
    [OUT, false, 'other'],
    [STRANGER, false, 'other'],
    [STRANGER, true, 'manager'],
  ] as const)('%s (manages: %s) is %s', (viewer, canManage, expected) => {
    expect(relationTo(booking, people, viewer, canManage)).toBe(expected);
  });

  it("makes the account linked to the booking's resource one of its people (D10)", () => {
    expect(relationTo(booking, people, STRANGER, false, STRANGER)).toBe('people');
    expect(relationTo(booking, people, STRANGER, false, IN)).toBe('other');
    expect(relationTo(booking, people, STRANGER, false, null)).toBe('other');
  });
});

describe('bookingView', () => {
  it("shows a stranger 'occupied' only: no name, no answer", () => {
    const view = bookingView(booking, people, 'other', 'occupied', STRANGER);
    expect(view).toEqual({
      id: 'b1',
      resourceId: 'r1',
      startsAt: '2026-11-02T10:00:00.000Z',
      endsAt: '2026-11-02T10:30:00.000Z',
      cancelled: false,
      mine: false,
    });
  });

  it("shows a stranger the names of a 'names' space, never the answers", () => {
    const view = bookingView(booking, people, 'other', 'names', STRANGER);
    expect(view.holderName).toBe('Holder');
    expect(view.participantNames).toEqual(['In']);
    expect(view).not.toHaveProperty('answers');
  });

  it('shows the people their names, a withdrawn one left out, and no answers', () => {
    const view = bookingView(booking, people, 'people', 'occupied', IN);
    expect(view).toMatchObject({ holderName: 'Holder', participantNames: ['In'], mine: true });
    expect(view).not.toHaveProperty('answers');
  });

  it.each([
    ['other', 'occupied', false],
    ['other', 'names', true],
    ['people', 'occupied', true],
    ['people', 'names', true],
    ['manager', 'occupied', true],
    ['manager', 'names', true],
  ] as const)(
    'sends holderId and holderName together: %s on an %s space -> %s',
    (relation, visibility, shown) => {
      const view = bookingView(booking, people, relation, visibility, STRANGER);
      expect('holderName' in view).toBe(shown);
      expect('holderId' in view).toBe(shown);
      expect((view as { holderId?: string }).holderId).toBe(shown ? HOLDER : undefined);
    }
  );

  it('shows the organiser the answers', () => {
    expect(bookingView(booking, people, 'manager', 'occupied', STRANGER).answers).toEqual({
      q: 'secret',
    });
  });

  it('marks a cancelled booking', () => {
    const cancelled = { ...booking, cancelledAt: new Date() };
    expect(bookingView(cancelled, people, 'people', 'names', HOLDER).cancelled).toBe(true);
  });
});

describe('privateInfoFor', () => {
  const space = { privateInfo: 'code' };
  const resource = { privateInfo: 'key' };

  it('gives the people and the organiser the texts of a live booking', () => {
    for (const relation of ['people', 'manager'] as const) {
      expect(privateInfoFor(relation, false, space, resource)).toEqual({
        spacePrivateInfo: 'code',
        resourcePrivateInfo: 'key',
      });
    }
  });

  it('gives nothing to a stranger, nor to anyone once cancelled', () => {
    expect(privateInfoFor('other', false, space, resource)).toBeNull();
    expect(privateInfoFor('people', true, space, resource)).toBeNull();
    expect(privateInfoFor('manager', true, space, resource)).toBeNull();
  });
});
