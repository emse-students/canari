import {
  approveMemberDevice,
  firstSightOfFlaggedAsk,
  markSweepOwed,
  memberDeviceAnswer,
  resetMemberDeviceAnswers,
  takeOwedSweep,
} from './memberDeviceAnswers';

/**
 * A SIGN-OUT FORGETS EVERYTHING THE SESSION WAS OWED. An owed sweep or an accusation said once
 * belongs to the account that was signed in: carried into the next one, a sweep would run for an
 * answer nobody gave and a genuine accusation would be read as already said.
 */
describe('resetMemberDeviceAnswers', () => {
  beforeEach(() => resetMemberDeviceAnswers());

  it('owes at most one more sweep, however many asked', () => {
    markSweepOwed();
    markSweepOwed();
    expect(takeOwedSweep()).toBe(true);
    expect(takeOwedSweep()).toBe(false);
  });

  it('forgets an owed sweep', () => {
    markSweepOwed();
    resetMemberDeviceAnswers();
    expect(takeOwedSweep()).toBe(false);
  });

  it('forgets the flagged asks already accused, so the next session accuses them again', () => {
    expect(firstSightOfFlaggedAsk('g1', 'peer')).toBe(true);
    expect(firstSightOfFlaggedAsk('g1', 'peer')).toBe(false);
    // Per conversation and per user: another pair is accused on its own.
    expect(firstSightOfFlaggedAsk('g2', 'peer')).toBe(true);
    resetMemberDeviceAnswers();
    expect(firstSightOfFlaggedAsk('g1', 'peer')).toBe(true);
  });

  it('forgets the approvals', () => {
    approveMemberDevice('peer', 'phone', 'fp-1');
    expect(memberDeviceAnswer('g1', 'peer', 'phone')).toEqual({
      kind: 'approved',
      fingerprint: 'fp-1',
    });
    resetMemberDeviceAnswers();
    expect(memberDeviceAnswer('g1', 'peer', 'phone')).toBeNull();
  });
});
