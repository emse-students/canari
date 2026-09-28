import { readWelcomeOwedFromRow } from './welcomeOwed';

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
