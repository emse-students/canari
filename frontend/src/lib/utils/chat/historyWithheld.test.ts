import {
  bindHistoryWithheld,
  historyWithheldEntries,
  historyWithheldFrom,
  MAX_HISTORY_WITHHELD,
  noteDeviceAddedByAMember,
  withholdHistoryFrom,
} from './historyWithheld';
import { approveMemberDevice, resetMemberDeviceAnswers } from './memberDeviceAnswers';

/**
 * HISTORY IS WITHHELD FROM AN UNVERIFIED DEVICE until a member vouches for it: a member's Add of
 * that very device, or this member's approval of it under the key it entered with.
 */
describe('historyWithheld', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bindHistoryWithheld([], null);
    resetMemberDeviceAnswers();
  });
  afterEach(() => vi.restoreAllMocks());

  it('withholds from that device in that conversation only', () => {
    withholdHistoryFrom('g1', 'Bob:web-9', 'fp');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    expect(historyWithheldFrom('g2', 'bob:web-9')).toBe(false);
    expect(historyWithheldFrom('g1', 'bob:phone-1')).toBe(false);
  });

  it("is lifted by a member's commit adding that device, never by its own", () => {
    withholdHistoryFrom('g1', 'bob:web-9', 'fp');
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'bob:web-9');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    noteDeviceAddedByAMember('g1', 'bob:web-9', null);
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'alice:phone-a');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(false);
  });

  it('is lifted by an approval under the key it entered with, and only that key', () => {
    withholdHistoryFrom('g1', 'bob:web-9', 'fp-entered');
    approveMemberDevice('bob', 'web-9', 'fp-other');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    approveMemberDevice('bob', 'web-9', 'fp-entered');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(false);
    expect(historyWithheldEntries()).toEqual([]);
  });

  it('persists every change through the bound account, and restores what it was given', () => {
    const persist = vi.fn();
    bindHistoryWithheld([{ groupId: 'g1', identity: 'bob:web-9', fingerprint: 'fp' }], persist);
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    withholdHistoryFrom('g2', 'carol:tab', 'fp2');
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'alice:phone-a');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('is bounded, and says so when the oldest record goes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i <= MAX_HISTORY_WITHHELD; i++) withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp');
    expect(historyWithheldEntries()).toHaveLength(MAX_HISTORY_WITHHELD);
    expect(historyWithheldFrom('g0', 'bob:web-9')).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
