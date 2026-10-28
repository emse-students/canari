import {
  anyHistoryWithheldIn,
  bindHistoryWithheld,
  committerIsWithheld,
  historyWithheldEntries,
  historySealedGroups,
  historyWithheldFrom,
  inheritsWithholding,
  MAX_HISTORY_WITHHELD,
  MAX_WITHHELD_PER_GROUP,
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
    expect(await anyHistoryWithheldIn('g1', async () => ['bob:web-9'])).toBe(true);
    expect(await anyHistoryWithheldIn('g2', async () => ['bob:web-9'])).toBe(false);
  });

  it('counts for broadcasts only a withheld device still in the tree, and an unreadable tree as present', async () => {
    await withholdHistoryFrom('g1', 'bob:web-9', 'fp', stillThere);
    expect(await anyHistoryWithheldIn('g1', async () => ['alice:phone-a'])).toBe(false);
    expect(
      await anyHistoryWithheldIn('g1', async () => {
        throw new Error('not held');
      })
    ).toBe(true);
    // A conversation with no record never reads its tree.
    const read = vi.fn(async () => []);
    expect(await anyHistoryWithheldIn('g2', read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('the seal gates answers, never who an Add is marked against', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i <= MAX_WITHHELD_PER_GROUP; i++) {
      await withholdHistoryFrom('g1', `bob:web-${i}`, 'fp', stillThere);
    }
    expect(historyWithheldFrom('g1', 'alice:phone-a')).toBe(true);
    const add = { groupId: 'g1', identity: 'carol:tab', addedBy: 'alice:phone-a' };
    expect(inheritsWithholding(add)).toBe(false);
    expect(inheritsWithholding({ ...add, addedBy: 'bob:web-0' })).toBe(true);
    error.mockRestore();
  });

  it('seals only on withheld devices still in the conversation', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gone = async (_g: string, identity: string) => identity !== 'bob:web-0';
    for (let i = 0; i <= MAX_WITHHELD_PER_GROUP; i++) {
      await withholdHistoryFrom('g1', `bob:web-${i}`, 'fp', gone);
    }
    expect(historyWithheldFrom('g1', 'alice:phone-a')).toBe(false);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('past the bound keeps a departed record while a withheld device remains in its conversation', async () => {
    // The remaining one could add the departed device back under its pinned key, which no event says.
    const leafStillIn = async (groupId: string, identity: string) =>
      !(groupId === 'g0' && identity === 'bob:left') && groupId !== 'g1';
    await withholdHistoryFrom('g0', 'bob:left', 'fp', leafStillIn);
    await withholdHistoryFrom('g0', 'bob:stays', 'fp', leafStillIn);
    await withholdHistoryFrom('g1', 'bob:gone', 'fp', leafStillIn);
    for (let i = 2; i < MAX_HISTORY_WITHHELD; i++) {
      await withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp', leafStillIn);
    }
    await withholdHistoryFrom('g-new', 'bob:web-9', 'fp', leafStillIn);
    expect(historyWithheldFrom('g0', 'bob:left')).toBe(true);
    expect(historyWithheldFrom('g1', 'bob:gone')).toBe(false);
  });

  it('seals a conversation past its bound: no history answered there to anyone, and it survives a restore', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i <= MAX_WITHHELD_PER_GROUP; i++) {
      await withholdHistoryFrom('g1', `bob:web-${i}`, 'fp', stillThere);
    }
    expect(historyWithheldFrom('g1', 'alice:phone-a')).toBe(true);
    expect(historyWithheldFrom('g2', 'alice:phone-a')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sealed'));
    bindHistoryWithheld([], null, historySealedGroups());
    expect(historyWithheldFrom('g1', 'alice:phone-a')).toBe(true);
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
