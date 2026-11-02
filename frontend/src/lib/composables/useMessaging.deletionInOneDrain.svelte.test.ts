/**
 * A MESSAGE AND ITS DELETION IN ONE CATCH-UP DRAIN (owner's report, 2026-11-02).
 *
 * A device away while the other person sent a message and deleted it receives both in one drain
 * when it comes back - or signs in again. The drain buffers inbound bodies until it ends, and
 * handles the `delete_message` the moment it is decrypted: at that instant the body is in neither
 * memory nor the store. The deletion was dropped as "nothing to delete", its frame consumed for
 * good, and the flush then rendered and persisted the deleted message.
 *
 * The two halves run here as the drain runs them - the real buffer, the real handler, one store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { m } from '$lib/paraglide/messages';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';

/** Same notification-name stub as `useMessaging.bulkIngest.svelte.test.ts`. */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      convo: Parameters<typeof real.notificationSenderName>[1]
    ) => real.notificationSenderName(senderId, convo),
    resolveDisplayNames: async () => (id: string) => id,
  };
});

/** Same import-cycle break as `useMessaging.bulkIngest.svelte.test.ts`. */
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const OTHER = 'other-member-id';
const CONVO = 'conversation-key';
const DRAIN = { bufferUi: true, showOverlay: true };

/** One store both halves write to, keyed by message id, as the real one is. */
function makeStore() {
  const rows = new Map<string, any>();
  const put = async (msg: any) => {
    rows.set(msg.id, { ...msg });
  };
  return {
    rows,
    saveMessage: vi.fn(put),
    saveMessages: vi.fn(async (msgs: any[]) => {
      for (const msg of msgs) await put(msg);
    }),
    getMessage: vi.fn(async (id: string) => rows.get(id) ?? null),
    getMessagesByIds: vi.fn(async (ids: string[]) => ({
      rows: new Map(ids.filter((id) => rows.has(id)).map((id) => [id, { ...rows.get(id) }])),
      unreadable: new Set<string>(),
    })),
    updateMessage: vi.fn(async (id: string, patch: any) => {
      const row = rows.get(id);
      if (!row) return;
      const next = { ...row };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      rows.set(id, next);
    }),
    saveMessageIfAbsent: vi.fn(async (msg: any) => {
      if (rows.has(msg.id)) return false;
      rows.set(msg.id, { ...msg });
      return true;
    }),
  };
}

function makeContext() {
  const store = makeStore();
  // As the boot restore seeds it: the row, and no message shown yet.
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: '',
    storage: store as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return { ctx, conversations, store };
}

/** The `delete_message` frame of the drain, handled by the real handler against the same state. */
function deletion(ctx: MessagingContext, by: string, messageId: string) {
  return handleSystemEvent('delete_message', { messageId }, {
    mlsService: {},
    storage: ctx.storage,
    userId: ME,
    deviceKey: () => 'device-key',
    conversations: ctx.conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: {},
    convoKey: CONVO,
    senderNorm: by,
    persistMlsStateNow: vi.fn(),
    deliveryMeta: { queuedCreatedAt: 9_000 },
  } as never);
}

const shown = (conversations: SvelteMap<string, Conversation>) =>
  conversations.get(CONVO)?.messages ?? [];

describe('a message and its deletion delivered in one drain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("shows and stores the TOMBSTONE, at the message's place - never the deleted text", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();

    messaging.beginBulkMessageIngest(DRAIN);
    await messaging.addMessageToChat(PEER, 'the deleted text', CONVO, ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
    });
    await deletion(ctx, PEER, 'm1');
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    const rows = shown(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', isDeleted: true, serverTimestamp: 2_000 });
    expect(rows[0].content).toBe(m.chat_system_message_deleted());
    expect(rows[0].deletedBeforeArrival).toBeUndefined();

    const row = store.rows.get('m1');
    expect(row.isDeleted).toBe(true);
    expect(row.content).toBe(m.chat_system_message_deleted());
    expect(row.serverTimestamp).toBe(2_000);
    expect(row.deletedBeforeArrival).toBe(false);
    // The deleted text never reached the store, not even transiently.
    for (const call of [...store.saveMessage.mock.calls, ...store.saveMessages.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('the deleted text');
    }
  });

  it("lets the message through when the deletion was not its author's", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    messaging.beginBulkMessageIngest(DRAIN);
    await messaging.addMessageToChat(PEER, 'a message', CONVO, ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
    });
    await deletion(ctx, OTHER, 'm1');
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    const rows = shown(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', content: 'a message', senderId: PEER });
    expect(rows[0].isDeleted).toBeUndefined();
    expect(store.rows.get('m1')).toMatchObject({ content: 'a message', senderId: PEER });
    expect(store.rows.get('m1').isDeleted).toBeUndefined();
  });

  it('absorbs a body arriving LIVE after its deletion was kept', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();

    await deletion(ctx, PEER, 'm1');
    await messaging.addMessageToChat(PEER, 'the deleted text', CONVO, ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
    });

    const rows = shown(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', isDeleted: true, serverTimestamp: 2_000 });
    expect(store.rows.get('m1').content).toBe(m.chat_system_message_deleted());
  });

  it('never upgrades a DELETED notification preview back into its body', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();
    // The push caption, in memory before the drain reached the body.
    conversations.set(CONVO, {
      ...conversations.get(CONVO)!,
      messages: [
        {
          id: 'm1',
          senderId: PEER,
          content: 'caption',
          timestamp: new Date(2_000),
          isOwn: false,
          isFcmPreview: true,
        },
      ],
    });
    store.rows.set('m1', { id: 'm1', conversationId: CONVO, senderId: PEER, content: 'caption' });

    messaging.beginBulkMessageIngest(DRAIN);
    await deletion(ctx, PEER, 'm1');
    await messaging.addMessageToChat(
      PEER,
      '{"kind":"text","text":"the deleted text"}',
      CONVO,
      ctx,
      { messageId: 'm1', serverTimestamp: 2_000 }
    );
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    expect(shown(conversations)[0]).toMatchObject({ id: 'm1', isDeleted: true });
    expect(shown(conversations)[0].content).toBe(m.chat_system_message_deleted());
    expect(store.rows.get('m1').content).toBe(m.chat_system_message_deleted());
  });
});
