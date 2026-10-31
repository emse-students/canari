// @vitest-environment happy-dom
import {
  listOwedInvitations,
  recordOwedInvitation,
  settleOwedInvitation,
  type OwedInvitation,
} from './owedInvitations';

/** The record a lost invitation waits in (`owedInvitations.ts`): one entry per lost commit. */
const U = 'user-a';
const entry = (groupId: string, baseEpoch: number): OwedInvitation => ({
  groupId,
  baseEpoch,
  invitation: { users: ['w5'], rostered: [] },
  cause: 'race',
});

describe('owedInvitations', () => {
  beforeEach(() => localStorage.clear());

  it('the same lost commit recorded twice is ONE entry', () => {
    recordOwedInvitation(U, entry('g', 2));
    recordOwedInvitation(U, entry('g', 2));
    expect(listOwedInvitations(U)).toEqual([entry('g', 2)]);
  });

  it('settles one entry and keeps the others, oldest base first', () => {
    recordOwedInvitation(U, entry('g', 5));
    recordOwedInvitation(U, entry('g', 2));
    recordOwedInvitation(U, entry('h', 3));
    settleOwedInvitation(U, entry('g', 2));
    expect(listOwedInvitations(U)).toEqual([entry('h', 3), entry('g', 5)]);
  });

  it('an unreadable record re-plans nothing, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(`mls_owed_invitations:v1:${U}`, '{not json');
    expect(listOwedInvitations(U)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
