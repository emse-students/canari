/**
 * F4 of community-open-budget: a salon's last page is kept on the device and drawn while its
 * server page is on the wire; the server page then replaces the copy, on screen and in the store.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { StoredMessage } from '$lib/db';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());
/** Row ids the mocked decoder counts as `v1 session not held` - they raise the notice. */
const droppedV1 = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessageRow: vi.fn(async (_raw: string, row: { id: string; at: number }) =>
    droppedV1.ids.includes(row.id)
      ? null
      : {
          kind: 'message',
          message: {
            id: row.id,
            senderId: 'peer',
            content: `server ${row.id}`,
            timestamp: new Date(row.at),
            isOwn: false,
            isSystem: false,
          },
        }
  ),
  UnreadableRowTally: class {
    report() {}
    rowsOf() {
      return droppedV1.ids;
    }
  },
  V1_SESSION_NOT_HELD: 'v1 session not held',
}));

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

function storedRow(id: string, at: number): StoredMessage {
  return { id, conversationId: SALON, senderId: 'peer', content: `stored ${id}`, timestamp: at };
}

function makeStorage(page: StoredMessage[] | (() => Promise<StoredMessage[]>)) {
  const calls: string[] = [];
  return {
    calls,
    getMessagesPage: vi.fn(async () => {
      calls.push('read');
      return typeof page === 'function' ? page() : page;
    }),
    deleteMessagesForConversation: vi.fn(async () => {
      calls.push('delete');
    }),
    saveMessages: vi.fn(async () => {
      calls.push('save');
    }),
  };
}

function makeCtx(storage: unknown) {
  return {
    storage,
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
  droppedV1.ids = [];
  listReadMarks.mockResolvedValue([]);
});

describe("a salon's stored page", () => {
  it('is drawn while the server page is on the wire, and nothing is deleted before it answers', async () => {
    const storage = makeStorage([storedRow('a', 1_000), storedRow('b', 2_000)]);
    let answer!: (rows: unknown[]) => void;
    listMessages.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage), {
      atTap: true,
    });
    await vi.waitFor(() =>
      expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['a', 'b'])
    );
    expect(storage.deleteMessagesForConversation).not.toHaveBeenCalled();

    answer([
      { id: 'b', at: 2_000 },
      { id: 'c', at: 3_000 },
    ]);
    await loading;
    // The copy's row the server no longer holds, older than its page, is withdrawn.
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['b', 'c']);
    expect(convs.conversations.get(SALON)?.messages[0].content).toBe('server b');
  });

  it('is replaced in the store by the server page, only once that page is in hand', async () => {
    const storage = makeStorage([storedRow('a', 1_000)]);
    listMessages.mockResolvedValue([{ id: 'c', at: 3_000 }]);
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    expect(storage.calls).toEqual(['read', 'delete', 'save']);
    expect(storage.saveMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'c', conversationId: SALON, timestamp: 3_000 })],
      'k'
    );
  });

  it('survives a failed server page: nothing deleted, the copy stays on screen', async () => {
    const storage = makeStorage([storedRow('a', 1_000)]);
    listMessages.mockRejectedValue(new Error('offline'));
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    expect(storage.deleteMessagesForConversation).not.toHaveBeenCalled();
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['a']);
  });

  it('is not read for a salon already drawn in this process', async () => {
    const storage = makeStorage([storedRow('a', 1_000)]);
    listMessages.mockResolvedValue([{ id: 'c', at: 3_000 }]);
    const convs = useConversations();
    convs.conversations.set(SALON, {
      ...salon(),
      messages: [{ id: 'live', senderId: 'p', content: 'x', timestamp: new Date(2_500) }],
    } as unknown as Conversation);

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    expect(storage.getMessagesPage).not.toHaveBeenCalled();
  });

  // Review of #1892 (2026-10-15): the server HARD-deletes a salon message, so a row missing from its
  // page is the only sign it is gone. The merge keeps rows newer than a page as live arrivals, and
  // an empty page removed nothing - so a copy's deleted newest row, or an emptied salon, stayed.
  it('withdraws a stored row newer than the page that the page does not name (a deleted message)', async () => {
    const storage = makeStorage([
      storedRow('a', 1_000),
      storedRow('b', 2_000),
      storedRow('z', 9_000),
    ]);
    listMessages.mockResolvedValue([
      { id: 'a', at: 1_000 },
      { id: 'b', at: 2_000 },
    ]);
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('withdraws every stored row when the server page is empty, and empties the copy', async () => {
    const storage = makeStorage([storedRow('a', 1_000), storedRow('b', 2_000)]);
    listMessages.mockResolvedValue([]);
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    expect(convs.conversations.get(SALON)?.messages).toEqual([]);
    expect(storage.calls).toEqual(['read', 'delete']);
  });

  it('keeps a message that arrived live after the stored page was drawn', async () => {
    const storage = makeStorage([storedRow('a', 1_000), storedRow('z', 9_000)]);
    let answer!: (rows: unknown[]) => void;
    listMessages.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));
    await vi.waitFor(() => expect(convs.conversations.get(SALON)?.messages).toHaveLength(2));
    const drawn = convs.conversations.get(SALON)!;
    convs.conversations.set(SALON, {
      ...drawn,
      messages: [
        ...drawn.messages,
        { id: 'live', senderId: 'peer', content: 'live', timestamp: new Date(10_000) },
      ],
    } as unknown as Conversation);
    answer([{ id: 'a', at: 1_000 }]);
    await loading;

    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['a', 'live']);
  });

  it('is not drawn by a load a newer one superseded while the store was read', async () => {
    let releaseFirstRead!: (rows: StoredMessage[]) => void;
    let reads = 0;
    const storage = makeStorage(() => {
      reads += 1;
      return reads === 1
        ? new Promise<StoredMessage[]>((resolve) => (releaseFirstRead = resolve))
        : Promise.resolve([]);
    });
    listMessages.mockReturnValue(new Promise(() => {}));
    const convs = useConversations();
    convs.conversations.set(SALON, salon());
    const ctx = makeCtx(storage);

    void convs.loadHistoryForConversation(SALON, SALON, ctx);
    await vi.waitFor(() => expect(reads).toBe(1));
    // A stale mark makes the next load its own rather than a join, and the newer generation.
    convs.invalidateChannelHistoryCache(SALON);
    void convs.loadHistoryForConversation(SALON, SALON, ctx);
    await vi.waitFor(() => expect(reads).toBe(2));
    releaseFirstRead([storedRow('old', 1_000)]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(convs.conversations.get(SALON)?.messages).toEqual([]);
  });

  it('never stores the older-messages notice, which is not a message', async () => {
    droppedV1.ids = ['gone'];
    const storage = makeStorage([]);
    listMessages.mockResolvedValue([
      { id: 'gone', at: 500, createdAt: new Date(500).toISOString() },
      { id: 'a', at: 1_000, createdAt: new Date(1_000).toISOString() },
    ]);
    const convs = useConversations();
    convs.conversations.set(SALON, salon());

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(storage));

    // On screen, first, as always; in the store, absent.
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.isSystem)).toEqual([true, false]);
    expect(storage.saveMessages).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })], 'k');
  });
});
