import {
  anyHistoryWithheldIn,
  bindHistoryWithheld,
  committerIsWithheld,
  historyWithheldEntries,
  historySealedGroups,
  sealHistoryIn,
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

  it('past the bound keeps every record of a conversation still held, its device present or not', async () => {
    // A departed device can come back by its own commit under its pinned key, which no event says.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leafStillIn = async (_g: string, identity: string) => identity !== 'bob:left';
    await withholdHistoryFrom('g0', 'bob:left', 'fp', leafStillIn);
    for (let i = 1; i <= MAX_HISTORY_WITHHELD; i++) {
      await withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp', leafStillIn);
    }
    expect(historyWithheldFrom('g0', 'bob:left')).toBe(true);
    expect(historyWithheldEntries()).toHaveLength(MAX_HISTORY_WITHHELD + 1);
    // Said once, not at every record past the bound.
    await withholdHistoryFrom('g-more', 'bob:web-9', 'fp', leafStillIn);
    expect(error.mock.calls.filter(([l]) => String(l).includes('past the bound'))).toHaveLength(1);
    error.mockRestore();
  });

  it('seals a conversation on demand, persisted with the records', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const persist = vi.fn();
    bindHistoryWithheld([], persist);
    sealHistoryIn('g1', 'device events were dropped');
    sealHistoryIn('g1', 'device events were dropped');
    expect(historyWithheldFrom('g1', 'alice:phone-a')).toBe(true);
    expect(historySealedGroups()).toEqual(['g1']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
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

  it('past the bound drops only records of conversations no longer held', async () => {
    const notHeld = new Set(['g3', 'g5']);
    const leafStillIn = async (groupId: string, identity: string) =>
      notHeld.has(groupId) ? ('group-not-held' as const) : identity !== 'bob:web-9';
    for (let i = 0; i < MAX_HISTORY_WITHHELD; i++) {
      await withholdHistoryFrom(`g${i}`, 'bob:web-9', 'fp', leafStillIn);
    }
    await withholdHistoryFrom('g-new', 'bob:web-9', 'fp', leafStillIn);
    expect(historyWithheldEntries()).toHaveLength(MAX_HISTORY_WITHHELD);
    expect(historyWithheldFrom('g3', 'bob:web-9')).toBe(false);
    expect(historyWithheldFrom('g5', 'bob:web-9')).toBe(true);
    // Departed from a conversation still held: kept.
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
