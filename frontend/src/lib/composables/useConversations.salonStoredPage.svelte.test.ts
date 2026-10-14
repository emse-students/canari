/**
 * F4 of community-open-budget: a salon's last page is kept on the device and drawn while its
 * server page is on the wire; the server page then replaces the copy, on screen and in the store.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { StoredMessage } from '$lib/db';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessageRow: vi.fn(async (_raw: string, row: { id: string; at: number }) => ({
    kind: 'message',
    message: {
      id: row.id,
      senderId: 'peer',
      content: `server ${row.id}`,
      timestamp: new Date(row.at),
      isOwn: false,
      isSystem: false,
    },
  })),
  UnreadableRowTally: class {
    report() {}
    rowsOf() {
      return [];
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

function makeStorage(page: StoredMessage[]) {
  const calls: string[] = [];
  return {
    calls,
    getMessagesPage: vi.fn(async () => {
      calls.push('read');
      return page;
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
});
