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

  // TWO GESTURES OWED AT ONE EPOCH ARE ONE ENTRY HOLDING BOTH (#3799 review): an invitation owed on
  // another device's add lock, then a kept commit at the same base refused - its settlement records
  // over the first, which used to be lost in silence.
  it('a second gesture owed at the same epoch is merged into the first, never written over it', () => {
    recordOwedInvitation(U, {
      groupId: 'g',
      baseEpoch: 2,
      invitation: { users: ['a'], rostered: [], seatGeneration: 4 },
      cause: 'race',
    });
    recordOwedInvitation(U, {
      groupId: 'g',
      baseEpoch: 2,
      invitation: { users: ['b'], rostered: ['b'], seatGeneration: 4 },
      cause: 'race',
      reason: 'epoch_mismatch',
    });
    expect(listOwedInvitations(U)).toEqual([
      {
        groupId: 'g',
        baseEpoch: 2,
        invitation: { users: ['a', 'b'], rostered: ['b'], seatGeneration: 4 },
        cause: 'race',
        reason: 'epoch_mismatch',
      },
    ]);
  });

  it('a seat generation is kept only when both gestures carry the same one', () => {
    recordOwedInvitation(U, {
      ...entry('g', 2),
      invitation: { users: ['a'], rostered: [], seatGeneration: 4 },
    });
    recordOwedInvitation(U, {
      ...entry('g', 2),
      invitation: { users: ['b'], rostered: [], seatGeneration: 6 },
    });
    expect(listOwedInvitations(U)[0].invitation).toEqual({ users: ['a', 'b'], rostered: [] });
  });

  it('a refusal and a race at the same epoch are two debts: one told, one re-planned', () => {
    recordOwedInvitation(U, entry('g', 2));
    recordOwedInvitation(U, {
      ...entry('g', 2),
      invitation: { users: ['x'] },
      cause: 'refused',
      reason: 'departed',
    });
    expect(listOwedInvitations(U).map((o) => [o.cause, o.invitation.users])).toEqual([
      ['race', ['w5']],
      ['refused', ['x']],
    ]);
  });

  // A RE-PLAN THAT CONCLUDED SETTLES THE PEOPLE IT COVERED, NOT THE KEY (#3799 review): a drain of g@E
  // holds the lock, a second invitation is refused by that very lock (SET NX refuses its own holder)
  // and merged into g@E; the drain concludes with its own snapshot - the second must stay owed.
  it('settling the snapshot a re-plan concluded keeps a gesture merged in while it ran', () => {
    recordOwedInvitation(U, entry('g', 2));
    const snapshot = listOwedInvitations(U)[0];
    recordOwedInvitation(U, { ...entry('g', 2), invitation: { users: ['w6'], rostered: ['w6'] } });

    settleOwedInvitation(U, snapshot);

    expect(listOwedInvitations(U)).toEqual([
      { ...entry('g', 2), invitation: { users: ['w6'], rostered: ['w6'] } },
    ]);
    settleOwedInvitation(U, listOwedInvitations(U)[0]);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('settles an entry an older build wrote under its bare key, whatever its cause', () => {
    localStorage.setItem(
      `mls_owed_invitations:v1:${U}`,
      JSON.stringify({ 'g@2': { ...entry('g', 2), cause: 'refused' } })
    );
    settleOwedInvitation(U, { ...entry('g', 2), cause: 'refused' });
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('an unreadable record re-plans nothing, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(`mls_owed_invitations:v1:${U}`, '{not json');
    expect(listOwedInvitations(U)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
