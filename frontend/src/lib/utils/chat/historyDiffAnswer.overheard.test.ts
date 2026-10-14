import { DIGEST_ID_MODE_MAX, buildHistoryDigest } from './historyManifest';
import { pullFromOverheardDigest } from './historyDiffAnswer';
import { owedPullTicket, resetOwedPulls } from './historyOverheardPull';

/**
 * What a member that OVERHEARD a digest does with it: diff it against its own store, and ask the
 * author - and only the author - for what it lacks. See `pullFromOverheardDigest`.
 */

const { readHistoryEntries, sendHistoryPull, sendHistoryBundleForIds, historyRangeStartFor } =
  vi.hoisted(() => ({
    readHistoryEntries: vi.fn(),
    sendHistoryPull: vi.fn().mockResolvedValue(undefined),
    sendHistoryBundleForIds: vi.fn().mockResolvedValue(undefined),
    historyRangeStartFor: vi.fn(),
  }));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  readHistoryEntries,
  sendHistoryPull,
  sendHistoryBundleForIds,
  historyRangeStartFor,
}));

const GROUP = 'g1';
const AUTHOR = 'peer:device-peer';
const SELF = 'me:device-me';
/** Our own window - deliberately NOT the one the digest arrived with. */
const OUR_SINCE = 1_700_000_000_000;

const entry = (id: string, timestamp = OUR_SINCE + 1000) => ({ id, timestamp });

function deps() {
  return { storage: null, deviceKeyB64: 'k', mlsService: {} as any, log: vi.fn() };
}

beforeEach(() => {
  resetOwedPulls();
  readHistoryEntries.mockReset();
  sendHistoryPull.mockClear();
  sendHistoryBundleForIds.mockClear();
  historyRangeStartFor.mockReset().mockResolvedValue(OUR_SINCE);
});

describe('pullFromOverheardDigest', () => {
  it('asks the AUTHOR for the ids it listed and we lack, stating OUR window', async () => {
    // The production shape: the author lists seven, we hold six of them.
    const held = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id));
    readHistoryEntries.mockResolvedValue(held);
    const digest = await buildHistoryDigest([...held, entry('g')]);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest,
      deps: d,
    });

    expect(sendHistoryPull).toHaveBeenCalledTimes(1);
    const [groupId, request] = sendHistoryPull.mock.calls[0];
    expect(groupId).toBe(GROUP);
    expect(request).toMatchObject({ from: SELF, to: AUTHOR, ids: ['g'], since: OUR_SINCE });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('naming 1 id(s) we lack'));
  });

  it('does not read the store for a digest that lists NOTHING - the probe of an empty device', async () => {
    // After a sign-in a device rejoins every group with nothing stored and opens each exchange with
    // its (empty) digest; every other member overhears it, once per group.
    const digest = await buildHistoryDigest([]);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest,
      deps: d,
    });

    expect(readHistoryEntries).not.toHaveBeenCalled();
    expect(sendHistoryPull).not.toHaveBeenCalled();
    // Silent: the `[HISTORY_DIGEST] From ... 0 id(s)` line on arrival already said it.
    expect(d.log).not.toHaveBeenCalled();
  });

  it('never ANSWERS the author - what it lacks is the elected responder job', async () => {
    readHistoryEntries.mockResolvedValue([entry('a'), entry('ours-only')]);
    const digest = await buildHistoryDigest([entry('a')]);

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest,
      deps: deps(),
    });

    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
    expect(sendHistoryPull).not.toHaveBeenCalled();
  });

  it('sends nothing and SAYS so when we hold everything it lists', async () => {
    const held = [entry('a'), entry('b')];
    readHistoryEntries.mockResolvedValue(held);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest: await buildHistoryDigest(held),
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('we hold everything it lists'));
  });

  it('does NOT pull by slice: every member would draw the whole slice of the author', async () => {
    // A differing slice says the stores differ, never who is short, and its answer is the author's
    // whole slice broadcast to the group - once per overhearing member. The author is usually the
    // device that is BEHIND (it asked), so here the slice holds nothing we lack at all.
    const held = Array.from({ length: 40 }, (_, i) => entry(`m-${String(i).padStart(3, '0')}`));
    readHistoryEntries.mockResolvedValue(held);
    // Forced into range mode, as a store above the id-mode cap would be.
    const digest = await buildHistoryDigest(held.slice(0, 30), 1);
    expect(digest.mode).toBe('range');
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest,
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    // Declined before the store is read: nothing it could say would change the answer.
    expect(readHistoryEntries).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('range digest'));
  });

  it('does NOT pull on an ids digest longer than any client builds - a forged frame', async () => {
    // The parser admits up to 5000 ids; an honest builder switches to range above 1000. Read as is,
    // one forged frame would make every member send ten pull frames.
    readHistoryEntries.mockResolvedValue([]);
    const ids = Array.from({ length: DIGEST_ID_MODE_MAX + 1 }, (_, i) => `x-${i}`);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest: { mode: 'ids', ids },
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('not pulled'));
  });

  it('still pulls the largest digest a client sends, which chunkIds splits into two frames', async () => {
    // The bound by construction: DIGEST_ID_MODE_MAX ids, MAX_IDS_PER_PULL per frame.
    readHistoryEntries.mockResolvedValue([]);
    const ids = Array.from({ length: DIGEST_ID_MODE_MAX }, (_, i) => `x-${i}`);

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest: { mode: 'ids', ids },
      deps: deps(),
    });

    expect(sendHistoryPull).toHaveBeenCalledTimes(1);
    expect(sendHistoryPull.mock.calls[0][1].ids).toHaveLength(DIGEST_ID_MODE_MAX);
  });

  it('claims nothing about a store it could not read', async () => {
    readHistoryEntries.mockResolvedValue(null);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      ticket: owedPullTicket(GROUP),
      digest: await buildHistoryDigest([entry('a')]),
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('store is unreadable'));
  });
});
