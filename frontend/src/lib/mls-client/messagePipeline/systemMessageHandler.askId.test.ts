import { handleSystemEvent } from './systemMessageHandler';
import {
  awaitProbe,
  digestIdentity,
  resetHistoryDigestRendezvousForTests,
} from '$lib/utils/chat/historyDigestRendezvous';
import { flushMacrotask } from '../../../test/flush';

/**
 * A HISTORY ASK WITH NO `requestId` IS MALFORMED, NEVER AN OLDER CLIENT (D211).
 *
 * Every build since step A (#2270, first in the stable `v1.5.0`) mints a `requestId` on each of the
 * three asks - `history_digest`, `history_pull`, `history_range` - and both estates' floor
 * (`minClientVersion` 1.6.6) is past it; a client below the floor cannot unlock MLS, so it cannot
 * put a frame on the wire. An ask without one is therefore refused where it is parsed: nothing is
 * stored for an answerer to elect, and nothing is answered - its asker would refuse an addressed
 * answer that names no ask anyway.
 */

const { answerHistoryDigest, pullFromOverheardDigest, sendHistoryBundleForIds } = vi.hoisted(
  () => ({
    answerHistoryDigest: vi.fn().mockResolvedValue(undefined),
    pullFromOverheardDigest: vi.fn().mockResolvedValue(undefined),
    sendHistoryBundleForIds: vi.fn().mockResolvedValue(undefined),
  })
);
vi.mock('$lib/utils/chat/historyDiffAnswer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyDiffAnswer')>()),
  answerHistoryDigest,
  pullFromOverheardDigest,
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  sendHistoryBundleForIds,
}));

const ME = 'me';
const MY_DEVICE = 'device-me';
const PEER_USER = 'peer';
const PEER = digestIdentity(PEER_USER, 'device-peer');
const GROUP = 'g1';
const ASK = 'ask-00000001';

function makeCtx() {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: {
      getDeviceId: () => MY_DEVICE,
      waitForGroupQueueIdle: vi.fn().mockResolvedValue(undefined),
    },
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

const refusedLine = (ctx: ReturnType<typeof makeCtx>, tag: string) =>
  ctx.log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`[${tag}] No request id`));

const DIGEST = { from: PEER, digest: { mode: 'ids', ids: ['m1', 'm2'] }, since: 0 };
const PULL = { from: PEER, to: digestIdentity(ME, MY_DEVICE), ids: ['m1'], since: 0 };
const RANGE = { from: PEER, before: 9000, limit: 50, since: 0 };

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  answerHistoryDigest.mockClear();
  pullFromOverheardDigest.mockClear();
  sendHistoryBundleForIds.mockClear();
});

describe('a history ask is read only with its request id (D211)', () => {
  it('a digest with no id is refused: no probe stored, nothing pulled or answered', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_digest', DIGEST, ctx as any);
    await flushMacrotask();

    expect(refusedLine(ctx, 'HISTORY_DIGEST')).toHaveLength(1);
    expect(pullFromOverheardDigest).not.toHaveBeenCalled();
    expect(answerHistoryDigest).not.toHaveBeenCalled();
    await expect(awaitProbe(GROUP, PEER, 0)).resolves.toBeNull();
  });

  it('a digest with its id is read as before', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_digest', { ...DIGEST, requestId: ASK }, ctx as any);
    await flushMacrotask();

    expect(refusedLine(ctx, 'HISTORY_DIGEST')).toEqual([]);
    expect(pullFromOverheardDigest).toHaveBeenCalledTimes(1);
  });

  it('a pull with no id is refused: nothing is sent', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_pull', PULL, ctx as any);
    await flushMacrotask();

    expect(refusedLine(ctx, 'HISTORY_PULL')).toHaveLength(1);
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });

  it('a pull with its id is answered, the id echoed', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_pull', { ...PULL, requestId: ASK }, ctx as any);
    await flushMacrotask();

    expect(sendHistoryBundleForIds).toHaveBeenCalledTimes(1);
    expect(sendHistoryBundleForIds.mock.calls[0][3]).toEqual({
      to: PEER,
      since: 0,
      requestId: ASK,
    });
  });

  it('a range with no id is refused: no probe stored for an answerer to elect', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_range', RANGE, ctx as any);

    expect(refusedLine(ctx, 'HISTORY_RANGE')).toHaveLength(1);
    await expect(awaitProbe(GROUP, PEER, 0)).resolves.toBeNull();
  });

  it('a range with its id is stored with it', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_range', { ...RANGE, requestId: ASK }, ctx as any);

    await expect(awaitProbe(GROUP, PEER, 0)).resolves.toEqual({
      kind: 'range',
      before: 9000,
      limit: 50,
      since: 0,
      requestId: ASK,
    });
  });

  it('an id shaped like nothing this build mints counts as none', async () => {
    const ctx = makeCtx();
    await handleSystemEvent('history_range', { ...RANGE, requestId: 'x y' }, ctx as any);

    expect(refusedLine(ctx, 'HISTORY_RANGE')).toHaveLength(1);
  });
});
