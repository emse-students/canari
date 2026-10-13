import { handleSystemEvent } from './systemMessageHandler';
import {
  digestIdentity,
  resetHistoryDigestRendezvousForTests,
} from '$lib/utils/chat/historyDigestRendezvous';

/**
 * A DIGEST OVERHEARD BY A MEMBER THAT WAS NEITHER SIDE OF THE EXCHANGE.
 *
 * Measured on production 2026-10-13: a phone asked its owner's other phone whether they held the
 * same history, the two exchanged a digest, and the owner's browser - a member of the group, so a
 * recipient of every leg - logged `[HISTORY_DIGEST] From ... 7 id(s)` while holding six, then
 * nothing. Nothing else on the browser could see the gap: no unreadable frame, no queued row, and a
 * connection pass that had no reason to sweep. The digest was the only evidence it would get.
 *
 * So an overheard digest is read for what WE lack, and only that: the author is asked for it by an
 * addressed pull, and nothing is answered on the author's behalf.
 */

const { answerHistoryDigest, pullFromOverheardDigest } = vi.hoisted(() => ({
  answerHistoryDigest: vi.fn().mockResolvedValue(undefined),
  pullFromOverheardDigest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/historyDiffAnswer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyDiffAnswer')>()),
  answerHistoryDigest,
  pullFromOverheardDigest,
}));

const ME = 'me';
const MY_DEVICE = 'device-me';
const PEER_USER = 'peer';
const PEER_DEVICE = 'device-peer';
const PEER = digestIdentity(PEER_USER, PEER_DEVICE);
const GROUP = 'g1';

function makeCtx(waitForGroupQueueIdle = vi.fn().mockResolvedValue(undefined)) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: { getDeviceId: () => MY_DEVICE, waitForGroupQueueIdle },
    storage: null,
    userId: ME,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: PEER_USER,
    persistMlsStateNow: vi.fn(),
  };
}

const DIGEST_FRAME = {
  from: PEER,
  digest: { mode: 'ids', ids: ['m1', 'm2'] },
  since: 0,
};

/** Lets the `void`-ed chain behind `answerAfterMailboxDrained` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  answerHistoryDigest.mockClear();
  pullFromOverheardDigest.mockClear();
});

describe('a digest overheard from an exchange between two other members', () => {
  it('asks its AUTHOR for what we lack, and answers nothing on its behalf', async () => {
    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).not.toHaveBeenCalled();
    expect(pullFromOverheardDigest).toHaveBeenCalledTimes(1);
    const call = pullFromOverheardDigest.mock.calls[0][0];
    expect(call.groupId).toBe(GROUP);
    // THE AUTHOR - the one device known, by its own statement, to hold what it listed.
    expect(call.holderIdentity).toBe(PEER);
    expect(call.selfIdentity).toBe(digestIdentity(ME, MY_DEVICE));
    expect(call.digest).toEqual(DIGEST_FRAME.digest);
  });

  it('waits for OUR mailbox on that group before reading the store', async () => {
    // A diff resolved mid-drain names what we hold SO FAR and asks for frames already on their way.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const waitForGroupQueueIdle = vi.fn().mockReturnValue(gate);

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx(waitForGroupQueueIdle) as any);
    await settle();
    expect(waitForGroupQueueIdle).toHaveBeenCalledWith(expect.any(String), GROUP);
    expect(pullFromOverheardDigest).not.toHaveBeenCalled();

    release();
    await settle();
    expect(pullFromOverheardDigest).toHaveBeenCalledTimes(1);
  });

  it('is not read at all when the digest is malformed', async () => {
    await handleSystemEvent(
      'history_digest',
      { from: PEER, digest: { mode: 'nonsense' }, since: 0 },
      makeCtx() as any
    );
    await settle();

    expect(pullFromOverheardDigest).not.toHaveBeenCalled();
  });
});
