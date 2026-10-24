// @vitest-environment happy-dom
/**
 * A HISTORY PAGE IS THE PROOF THAT SETTLES A SALON ECHO WHOSE POST REPLY WAS LOST (WP-OFF-2).
 *
 * The author's row carries, inside its ciphertext, the client UUID the echo is shown under. A page
 * holding it must re-key the echo to the server's row - one row, never two - and forget the text the
 * unsent ledger kept for it, or the next page life hands a DELIVERED message back to the composer.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { ChatMessage, Conversation } from '$lib/types';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

vi.mock('$lib/utils/chat/channelCrypto', () => {
  return {
    isChannelConversationId: (id: string) => id.startsWith('channel_'),
    decodeChannelMessagePage: vi.fn(
      async (raw: string, rows: readonly unknown[], me: string, tally: unknown) => {
        // The page entry decodes row by row through the stub below, as the real one does.
        const { decodeChannelMessageRow } = await import('$lib/utils/chat/channelCrypto');
        const out = [];
        for (const r of rows)
          out.push(await decodeChannelMessageRow(raw, r as never, me, tally as never));
        return out;
      }
    ),
    decodeChannelMessageRow: vi.fn(async (_raw: string, row: { id: string }) => ({
      kind: 'message',
      message: {
        id: row.id,
        senderId: 'u1',
        content: 'hello',
        timestamp: new Date(2_000),
        serverTimestamp: 2_000,
        clientMessageId: 'local-1',
        isOwn: true,
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
  };
});

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');
const { recordUnsentSalonText, takeOrphanedSalonTexts } =
  await import('$lib/utils/chat/salonUnsent');

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000002';

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

const echo: ChatMessage = {
  id: 'local-1',
  senderId: 'u1',
  content: 'hello',
  timestamp: new Date(2_400),
  isOwn: true,
  status: 'sending',
  awaitingServerId: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listMessages.mockResolvedValue([{ id: 'srv-1' }]);
  listReadMarks.mockResolvedValue([]);
});

describe('a history load and the salon echo', () => {
  it('re-keys the echo to the server row and forgets its unsent text', async () => {
    recordUnsentSalonText('u1', { messageId: 'local-1', conversationKey: SALON, text: 'hello' });
    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [{ ...echo }],
    } as unknown as Conversation);

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());

    const rows = convs.conversations.get(SALON)!.messages;
    expect(rows.map((m) => m.id)).toEqual(['srv-1']);
    expect(rows[0].awaitingServerId).toBeUndefined();
    expect(await takeOrphanedSalonTexts('u1', SALON, new Set())).toEqual([]);
  });
});
