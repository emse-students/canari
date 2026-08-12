/**
 * The scrollback: what a reader who has hit the bottom of their own store may ask a peer for.
 *
 * The device window is finite - ninety days on the web - so this is the only way a browser ever
 * obtains a past it never received. Everything here is about the BOUNDARY: the ask is for the page
 * below the oldest message held, it is refused once that page would be below our own floor, and a
 * failure to reach anybody is reported rather than swallowed, because "nobody was online" is the one
 * outcome the reader has to be told about.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';

const historyRangeStartFor = vi.hoisted(() => vi.fn());
const sendHistoryRangeRequest = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return { ...actual, historyRangeStartFor, sendHistoryRangeRequest };
});

// The composable is reachable from its own import graph: `groupCreation` pulls in the global chat
// singleton, which instantiates every composable - including this one - at module scope. Importing
// the module directly closes that cycle and leaves a binding uninitialised. The singleton is a
// production wiring detail with nothing to say about one function, so it is stubbed away.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const DM = 'peer-dm';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000001';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** A conversation holding `times` as its message instants, in the order given. */
function conversation(times: number[]): Conversation {
  return {
    id: GROUP_ID,
    name: DM,
    messages: times.map((t, i) => ({
      id: `m${i}`,
      senderId: 'u2',
      content: 'x',
      timestamp: new Date(t),
    })),
  } as unknown as Conversation;
}

function makeCtx(over: { storage?: unknown; election?: unknown } = {}) {
  const sendHistoryRequest = vi
    .fn()
    .mockImplementation(async () =>
      over.election instanceof Error ? Promise.reject(over.election) : (over.election ?? {})
    );
  const mls = { sendHistoryRequest, getDeviceId: () => 'dev-1' };
  return {
    mls,
    log: vi.fn(),
    ctx: {
      storage: 'storage' in over ? over.storage : ({} as never),
      ensureMls: () => mls,
      userId: 'u1',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.test',
      messageReactions: new SvelteMap(),
      log: vi.fn(),
      addMessageToChat: vi.fn(),
    } as never,
  };
}

/** A composable whose map already holds `convo` under {@link DM}. */
function withConversation(convo: Conversation) {
  const convs = useConversations();
  convs.conversations.set(DM, convo);
  return convs;
}

beforeEach(() => {
  vi.clearAllMocks();
  historyRangeStartFor.mockResolvedValue(0);
  sendHistoryRangeRequest.mockResolvedValue(true);
});

describe('requestOlderFromPeers', () => {
  it('asks for the page BELOW the oldest message held, bounded by our own window', async () => {
    const convs = withConversation(conversation([NOW, NOW - 3 * DAY, NOW - DAY]));
    historyRangeStartFor.mockResolvedValue(NOW - 90 * DAY);
    const { ctx } = makeCtx();

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('asked');

    // The oldest, not the last in the array: the list is not required to be sorted here, and asking
    // before the newest would re-request everything the device already holds.
    expect(sendHistoryRangeRequest).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ before: NOW - 3 * DAY, limit: 50, since: NOW - 90 * DAY }),
      expect.anything()
    );
  });

  it('states its own window on the ask, because the answerer never recomputes one', async () => {
    const convs = withConversation(conversation([NOW]));
    historyRangeStartFor.mockResolvedValue(NOW - 5 * 365 * DAY);
    const { ctx } = makeCtx();

    await convs.requestOlderFromPeers(DM, ctx);

    const [, payload] = sendHistoryRangeRequest.mock.calls[0];
    expect(payload.since).toBe(NOW - 5 * 365 * DAY);
    // The answer is addressed back to this device, not broadcast to the user: a second device of
    // ours holding a different window has no use for a page bounded by this one's.
    expect(payload.from).toBe(digestIdentity('u1', 'dev-1'));
  });

  it('elects a responder BEFORE sending the range frame', async () => {
    const order: string[] = [];
    const convs = withConversation(conversation([NOW]));
    const { ctx, mls } = makeCtx();
    mls.sendHistoryRequest.mockImplementation(async () => {
      order.push('elect');
      return {};
    });
    sendHistoryRangeRequest.mockImplementation(async () => {
      order.push('range');
      return true;
    });

    await convs.requestOlderFromPeers(DM, ctx);
    expect(order).toEqual(['elect', 'range']);
  });

  it('refuses once the oldest message held already reaches our floor', async () => {
    // There is nothing below the window that anybody is entitled to send us, so the ask would be a
    // frame every member decrypts for an answer that must be empty.
    const convs = withConversation(conversation([NOW - 90 * DAY]));
    historyRangeStartFor.mockResolvedValue(NOW - 90 * DAY);
    const { ctx, mls } = makeCtx();

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('unavailable');
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(sendHistoryRangeRequest).not.toHaveBeenCalled();
  });

  it('reports no-peer when the server elected nobody, without sending the frame', async () => {
    const convs = withConversation(conversation([NOW]));
    const { ctx } = makeCtx({ election: { noPeerOnline: true } });

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('no-peer');
    expect(sendHistoryRangeRequest).not.toHaveBeenCalled();
  });

  it('reports no-peer when the election never left the device', async () => {
    // A transport failure is not an answer about the peers - but from the reader's side the two are
    // the same outcome: nobody is going to send anything, and the spinner must not run for ever.
    const convs = withConversation(conversation([NOW]));
    const { ctx } = makeCtx({ election: new Error('Failed to fetch') });

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('no-peer');
    expect(sendHistoryRangeRequest).not.toHaveBeenCalled();
  });

  it('reports unavailable when the frame itself could not be sent', async () => {
    const convs = withConversation(conversation([NOW]));
    sendHistoryRangeRequest.mockResolvedValue(false);

    expect(await convs.requestOlderFromPeers(DM, makeCtx().ctx)).toBe('unavailable');
  });

  it('asks nothing for a conversation holding no messages at all', async () => {
    // That case belongs to the reconciliation on connect: there is no instant to ask BEFORE, and an
    // empty store is exactly what the state key comparison repairs.
    const convs = withConversation(conversation([]));
    const { ctx, mls } = makeCtx();

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('unavailable');
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('asks nothing for a channel, which is served over REST and not by peers', async () => {
    const convs = useConversations();
    convs.conversations.set('channel_abc', conversation([NOW]));
    const { ctx, mls } = makeCtx();

    expect(await convs.requestOlderFromPeers('channel_abc', ctx)).toBe('unavailable');
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('asks nothing for a conversation this device does not hold', async () => {
    const convs = useConversations();
    const { ctx, mls } = makeCtx();

    expect(await convs.requestOlderFromPeers('never-seen', ctx)).toBe('unavailable');
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('asks nothing before the storage exists', async () => {
    // Pre-login, or mid-unlock. Without a store there is no floor to state, and a range ask with no
    // window would be answered with whatever the peer felt like.
    const convs = withConversation(conversation([NOW]));
    const { ctx, mls } = makeCtx({ storage: null });

    expect(await convs.requestOlderFromPeers(DM, ctx)).toBe('unavailable');
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });
});
