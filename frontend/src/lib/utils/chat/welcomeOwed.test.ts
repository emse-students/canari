import { isStrandedSeat, readWelcomeOwedFromRow } from './welcomeOwed';

/**
 * The one reading that picks a door into a group - shared by conversation recovery and, since
 * channel-encryption section 20, by the Graine key-group join.
 */
const row = (fields: Record<string, unknown>) =>
  ({ id: 'r', userId: 'u', deviceId: 'd', groupId: 'g', ...fields }) as never;

describe('readWelcomeOwedFromRow', () => {
  it("no row, or an active one, is the device's own door", () => {
    expect(readWelcomeOwedFromRow(undefined)).toBe('not-pending');
    expect(readWelcomeOwedFromRow(row({ status: 'active' }))).toBe('not-pending');
  });

  it('a pending row with a queued Welcome or an add in flight is owed', () => {
    expect(readWelcomeOwedFromRow(row({ status: 'pending', welcomeQueued: true }))).toBe('owed');
    expect(
      readWelcomeOwedFromRow(row({ status: 'pending', welcomeQueued: false, addInFlight: true }))
    ).toBe('owed');
  });

  it('a pending row nothing follows is an unhonoured seat', () => {
    expect(
      readWelcomeOwedFromRow(row({ status: 'pending', welcomeQueued: false, addInFlight: false }))
    ).toBe('unhonoured-seat');
  });

  it('a server that does not say is not a server saying no', () => {
    expect(readWelcomeOwedFromRow(row({ status: 'pending' }))).toBe('owed');
  });
});

describe('isStrandedSeat', () => {
  const seat = (over: Record<string, unknown> = {}) => ({
    status: 'pending',
    welcomeQueued: false,
    addInFlight: false,
    admitted: false,
    ...over,
  });
  const g = (deviceMembership: unknown) =>
    ({ groupId: 'g', name: 'G', isGroup: true, deviceMembership }) as never;

  it('is stranded: holds the tree, pending, nothing queued, nothing in flight, nobody admitted it', () => {
    expect(isStrandedSeat(g(seat()), true)).toBe(true);
  });

  it('is not stranded while a Welcome is queued, an add is in flight, or a commit admitted it', () => {
    expect(isStrandedSeat(g(seat({ welcomeQueued: true })), true)).toBe(false);
    expect(isStrandedSeat(g(seat({ addInFlight: true })), true)).toBe(false);
    expect(isStrandedSeat(g(seat({ admitted: true })), true)).toBe(false);
  });

  it('is not stranded when active, absent, or from a server that does not say', () => {
    expect(isStrandedSeat(g(seat({ status: 'active' })), true)).toBe(false);
    expect(isStrandedSeat(g(null), true)).toBe(false);
    expect(isStrandedSeat(g(undefined), true)).toBe(false);
    expect(isStrandedSeat(g({ status: 'pending' }), true)).toBe(false);
  });

  it('leaves a device that holds no tree to the missing-group seam', () => {
    expect(isStrandedSeat(g(seat()), false)).toBe(false);
  });
});
