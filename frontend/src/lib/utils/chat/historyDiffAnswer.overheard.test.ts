import { buildHistoryDigest } from './historyManifest';
import { pullFromOverheardDigest } from './historyDiffAnswer';

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
      digest,
      deps: d,
    });

    expect(sendHistoryPull).toHaveBeenCalledTimes(1);
    const [groupId, request] = sendHistoryPull.mock.calls[0];
    expect(groupId).toBe(GROUP);
    expect(request).toMatchObject({ from: SELF, to: AUTHOR, ids: ['g'], since: OUR_SINCE });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('naming 1 id(s)/slice(s) we lack'));
  });

  it('never ANSWERS the author - what it lacks is the elected responder job', async () => {
    readHistoryEntries.mockResolvedValue([entry('a'), entry('ours-only')]);
    const digest = await buildHistoryDigest([entry('a')]);

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
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
      digest: await buildHistoryDigest(held),
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('we hold everything it lists'));
  });

  it('pulls by SLICE when the digest is a range manifest', async () => {
    const held = Array.from({ length: 40 }, (_, i) => entry(`m-${String(i).padStart(3, '0')}`));
    readHistoryEntries.mockResolvedValue(held);
    // Forced into range mode, as a store above the id-mode cap would be.
    const digest = await buildHistoryDigest([...held, entry('zz-missing')], 1);
    expect(digest.mode).toBe('range');

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      digest,
      deps: deps(),
    });

    expect(sendHistoryPull).toHaveBeenCalledTimes(1);
    const request = sendHistoryPull.mock.calls[0][1];
    expect(request.to).toBe(AUTHOR);
    expect(request.ids).toEqual([]);
    expect(request.prefixes.length).toBeGreaterThan(0);
    expect(request.depth).toBe(digest.mode === 'range' ? digest.depth : undefined);
  });

  it('claims nothing about a store it could not read', async () => {
    readHistoryEntries.mockResolvedValue(null);
    const d = deps();

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      digest: await buildHistoryDigest([entry('a')]),
      deps: d,
    });

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('store is unreadable'));
  });
});
