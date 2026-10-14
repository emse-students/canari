/**
 * A salon's in-memory history is current exactly as long as the live stream that keeps it current
 * has had no gap - never "for five minutes after its load", which is what it used to be. Measured
 * on a Mi 9T, 2026-10-01: a message posted while the app was backgrounded reached the device as a
 * push only, and the open salon did not show it after resume until that clock ran out, because
 * nothing re-fetched it. These pin the replacement: a clock never expires a copy, a stream gap does.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

vi.mock('$lib/utils/chat/channelCrypto', () => {
  return {
    isChannelConversationId: (id: string) => id.startsWith('channel_'),
    decodeChannelMessageRow: vi.fn(async (_raw: string, row: { id: string }) => ({
      kind: 'message',
      message: {
        id: row.id,
        senderId: 'peer',
        content: 'hi',
        timestamp: new Date(1_000),
        isOwn: false,
        isSystem: false,
      },
    })),
    UnreadableRowTally: class {
      report() {}
      // Every row decodes here, so no row is ever dropped and no older-messages notice is added.
      rowsOf() {
        return [];
      }
    },
    V1_SESSION_NOT_HELD: 'v1 session not held',
  };
});

// Same isolation reasoning as the other useConversations tests: the composable is reachable from
// the global chat singleton's own module-scope instantiation.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000001';

function makeCtx() {
  return {
    storage: null,
    ensureMls: () => ({}),
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: '',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

function salon(): Conversation {
  return { id: SALON, name: SALON, messages: [] } as unknown as Conversation;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMessages.mockResolvedValue([{ id: 'm1' }]);
  listReadMarks.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('salon history cache - stale by event, never by clock', () => {
  it('keeps a loaded salon current however much time passes while the stream holds', async () => {
    vi.useFakeTimers();
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    const ctx = makeCtx();

    await convs.loadHistoryForConversation(SALON, SALON, ctx);
    vi.advanceTimersByTime(60 * 60 * 1000);
    await convs.loadHistoryForConversation(SALON, SALON, ctx);

    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('re-fetches a salon whose stream went down after it was loaded', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    const ctx = makeCtx();

    await convs.loadHistoryForConversation(SALON, SALON, ctx);
    await convs.noteLiveStreamTransition(false, ctx);
    await convs.loadHistoryForConversation(SALON, SALON, ctx);

    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('reloads the OPEN salon when the stream comes back, with nothing re-selected', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    convs.selectConversation(SALON);
    const ctx = makeCtx();

    await convs.loadHistoryForConversation(SALON, SALON, ctx);
    await convs.noteLiveStreamTransition(false, ctx);
    await convs.noteLiveStreamTransition(true, ctx);

    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it("a load takes the reader's own mark from the server, not from a belief restored from disk", async () => {
    // A mark advanced locally and never delivered used to survive every load (max-merge), so the
    // receipt effect never saw reading move it and never posted it (#infos, 2026-10-09).
    localStorage.clear();
    listReadMarks.mockResolvedValue({ u1: 500, peer: 700 });
    const convs = useConversations();
    convs.conversations.set(SALON, { ...salon(), readWatermarks: { u1: 9_000 } });

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());

    expect(convs.conversations.get(SALON)?.readWatermarks).toEqual({ u1: 500, peer: 700 });
  });

  it('reloads nothing on reconnect when no salon is open', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    const ctx = makeCtx();

    await convs.loadHistoryForConversation(SALON, SALON, ctx);
    await convs.noteLiveStreamTransition(true, ctx);

    expect(listMessages).toHaveBeenCalledTimes(1);
  });
});

describe('a salon history request issued at the tap', () => {
  it('raises the skeleton and asks the server although the salon is not selected yet', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    let release!: (rows: unknown[]) => void;
    listMessages.mockReturnValue(new Promise((resolve) => (release = resolve)));
    expect(convs.selectedContact).not.toBe(SALON);

    const pending = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { atTap: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    // The pane mounts a frame later: the skeleton is there for the salon it was raised for.
    convs.selectConversation(SALON);
    expect(convs.isLoadingHistory).toBe(true);

    release([{ id: 'm1' }]);
    await pending;
    expect(convs.isLoadingHistory).toBe(false);
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('the skeleton raised at the tap belongs to its salon', () => {
  const OTHER = 'channel_7d2f0aa0-0000-4000-8000-000000000002';

  it('is not shown on another salon selected while it is still up', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    convs.conversations.set(OTHER, { ...salon(), id: OTHER, name: OTHER } as Conversation);
    listMessages.mockReturnValue(new Promise(() => {}));

    void convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { atTap: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));

    convs.selectConversation(SALON);
    expect(convs.isLoadingHistory).toBe(true);
    convs.selectConversation(OTHER);
    expect(convs.isLoadingHistory).toBe(false);
  });
});
