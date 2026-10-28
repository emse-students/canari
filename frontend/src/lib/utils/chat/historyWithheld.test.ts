import {
  anyHistoryWithheldIn,
  bindHistoryWithheld,
  committerIsWithheld,
  historyWithheldEntries,
  historyWithheldFrom,
  MAX_HISTORY_WITHHELD,
  noteDeviceAddedByAMember,
  withholdHistoryFrom,
} from './historyWithheld';
import { approveMemberDevice, resetMemberDeviceAnswers } from './memberDeviceAnswers';

/**
 * HISTORY IS WITHHELD FROM AN UNVERIFIED DEVICE until a member vouches for it: an Add of that very
 * device by a device that is not withheld there, or this member's approval of it under the key it
 * entered with. What a withheld device adds is withheld too.
 */
describe('historyWithheld', () => {
  const stillThere = async () => true;
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bindHistoryWithheld([], null);
    resetMemberDeviceAnswers();
  });
  afterEach(() => vi.restoreAllMocks());

  it('withholds from that device in that conversation only', async () => {
    await withholdHistoryFrom('g1', 'Bob:web-9', 'fp', stillThere);
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    expect(historyWithheldFrom('g2', 'bob:web-9')).toBe(false);
    expect(historyWithheldFrom('g1', 'bob:phone-1')).toBe(false);
    expect(anyHistoryWithheldIn('g1')).toBe(true);
    expect(anyHistoryWithheldIn('g2')).toBe(false);
  });

  it("is lifted by a member's commit adding that device, never by its own", async () => {
    await withholdHistoryFrom('g1', 'bob:web-9', 'fp', stillThere);
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'bob:web-9');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    noteDeviceAddedByAMember('g1', 'bob:web-9', null);
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'alice:phone-a');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(false);
  });

  it('is not lifted by an Add made by a device itself withheld there, and such an Add is marked', async () => {
    // The sibling Add: a withheld device adds a second one, then re-adds itself through it.
    await withholdHistoryFrom('g1', 'bob:web-9', 'fp', stillThere);
    await withholdHistoryFrom('g1', 'bob:web-10', 'fp2', stillThere);
    expect(committerIsWithheld('g1', 'bob:web-11', 'bob:web-9')).toBe(true);
    expect(committerIsWithheld('g1', 'bob:web-9', 'bob:web-9')).toBe(false);
    expect(committerIsWithheld('g1', 'bob:web-11', 'alice:phone-a')).toBe(false);
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'bob:web-10');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
  });

  it('is lifted by an approval under the key it entered with, and only that key', async () => {
    await withholdHistoryFrom('g1', 'bob:web-9', 'fp-entered', stillThere);
    approveMemberDevice('bob', 'web-9', 'fp-other');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    approveMemberDevice('bob', 'web-9', 'fp-entered');
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(false);
    expect(historyWithheldEntries()).toEqual([]);
  });

  it('persists every change through the bound account, and restores what it was given', async () => {
    const persist = vi.fn();
    bindHistoryWithheld([{ groupId: 'g1', identity: 'bob:web-9', fingerprint: 'fp' }], persist);
    expect(historyWithheldFrom('g1', 'bob:web-9')).toBe(true);
    await withholdHistoryFrom('g2', 'carol:tab', 'fp2', stillThere);
    noteDeviceAddedByAMember('g1', 'bob:web-9', 'alice:phone-a');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('past the bound drops only records whose device left its tree', async () => {
    const gone = new Set(['g3', 'g5']);
    const leafStillIn = async (groupId: string) => !gone.has(groupId);
    for (let i = 0; i < MAX_HISTORY_WITHHELD; i++) {
      await withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp', leafStillIn);
    }
    await withholdHistoryFrom('g-new', 'bob:web-9', 'fp', leafStillIn);
    expect(historyWithheldEntries()).toHaveLength(MAX_HISTORY_WITHHELD);
    expect(historyWithheldFrom('g3', 'bob:web-9')).toBe(false);
    expect(historyWithheldFrom('g5', 'bob:web-9')).toBe(true);
    expect(historyWithheldFrom('g0', 'bob:web-9')).toBe(true);
  });

  it('never drops a record whose device is still there, or whose tree is unreadable: it fails closed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i <= MAX_HISTORY_WITHHELD; i++) {
      await withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp', async () =>
        i % 2 === 0 ? true : 'unreadable'
      );
    }
    expect(historyWithheldEntries()).toHaveLength(MAX_HISTORY_WITHHELD + 1);
    expect(historyWithheldFrom('g0', 'bob:web-9')).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('none is dropped'));
  });
});
