/**
 * A MUTATION REACHES ITS MESSAGE WHEREVER THE MESSAGE IS (2026-11-02, the follow-up of the owner's
 * deleted-message report).
 *
 * Memory is a window: the boot restore seeds every conversation with `messages: []`, and an opened
 * one holds its last page. An edit or a reaction whose message was stored but not shown, or still
 * in a catch-up drain's buffer, was dropped; and a body re-delivered for a stored row that memory
 * did not show was written over that row whole - its tombstone included.
 *
 * The drain runs here as it runs in the app: the real buffer, the real handlers, one store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation, MessageReaction } from '$lib/types';
import { m } from '$lib/paraglide/messages';
import { envelopeBodyText, mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';
import { applyReactionFrame } from '$lib/mls-client/messagePipeline/reactionFrame';
import { clearHeldEdits } from '$lib/utils/chat/heldEdits';

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
const BODY = serializeEnvelope(mkTextEnvelope('original'));

/** One store every half writes to, keyed by message id, with rows it cannot open. */
function makeStore() {
  const rows = new Map<string, any>();
  const unreadable = new Set<string>();
  const put = async (msg: any) => {
    rows.set(msg.id, { ...msg });
  };
  return {
    rows,
    unreadable,
    saveMessage: vi.fn(put),
    saveMessages: vi.fn(async (msgs: any[]) => {
      for (const msg of msgs) await put(msg);
    }),
    getMessagesByIds: vi.fn(async (ids: string[]) => ({
      rows: new Map(ids.filter((id) => rows.has(id)).map((id) => [id, { ...rows.get(id) }])),
      unreadable: new Set(ids.filter((id) => unreadable.has(id))),
    })),
    updateMessage: vi.fn(async (id: string, patch: any) => {
      const row = rows.get(id);
      if (!row) return;
      const next = { ...row };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      rows.set(id, next);
    }),
    saveMessageIfAbsent: vi.fn(async (msg: any) => {
      if (rows.has(msg.id) || unreadable.has(msg.id)) return false;
      rows.set(msg.id, { ...msg });
      return true;
    }),
  };
}

function makeContext() {
  const store = makeStore();
  // As the boot restore seeds it: the row, and no message shown.
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

/** A system event of the drain, handled by the real handler against the same state. */
function systemEvent(
  ctx: MessagingContext,
  reactions: SvelteMap<string, MessageReaction[]>,
  by: string,
  event: string,
  data: Record<string, unknown>
) {
  return handleSystemEvent(event, data, {
    mlsService: {},
    storage: ctx.storage,
    userId: ME,
    deviceKey: () => 'device-key',
    conversations: ctx.conversations,
    messageReactions: reactions,
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

/** A reaction frame, through the real applier, against the same state. */
function reactionFrame(
  ctx: MessagingContext,
  reactions: SvelteMap<string, MessageReaction[]>,
  by: string,
  messageId: string
) {
  return applyReactionFrame(
    {
      storage: ctx.storage,
      deviceKey: () => 'device-key',
      conversations: ctx.conversations as never,
      messageReactions: reactions,
      log: vi.fn(),
    },
    CONVO,
    by,
    { messageId, emoji: '👍', at: 5_000, removed: false },
    undefined
  );
}

const storedBody = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  conversationId: CONVO,
  senderId: PEER,
  content: BODY,
  timestamp: 1_000,
  ...extra,
});

const shown = (conversations: SvelteMap<string, Conversation>) =>
  conversations.get(CONVO)?.messages ?? [];

beforeEach(() => {
  vi.restoreAllMocks();
  clearHeldEdits();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('an edit whose message is stored but not shown', () => {
  it('rewrites the STORED row', async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    store.rows.set('m1', storedBody());

    await systemEvent(ctx, messaging.messageReactions, PEER, 'edit_message', {
      messageId: 'm1',
      newContent: 'rewritten',
      editedAt: 4_000,
    });

    expect(envelopeBodyText(store.rows.get('m1').content)).toBe('rewritten');
    expect(store.rows.get('m1')).toMatchObject({ isEdited: true, editedAt: 4_000 });
  });

  it('refuses it from anybody but the author, and never touches a stored tombstone', async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    store.rows.set('m1', storedBody());
    store.rows.set('m2', storedBody({ id: 'm2', isDeleted: true, content: 'deleted' }));

    await systemEvent(ctx, messaging.messageReactions, OTHER, 'edit_message', {
      messageId: 'm1',
      newContent: 'forged',
      editedAt: 4_000,
    });
    await systemEvent(ctx, messaging.messageReactions, PEER, 'edit_message', {
      messageId: 'm2',
      newContent: 'back from the dead',
      editedAt: 4_000,
    });

    expect(store.rows.get('m1').content).toBe(BODY);
    expect(store.rows.get('m2').content).toBe('deleted');
  });
});

describe('an edit delivered in the same drain as its message', () => {
  it('lands with the body - shown and stored edited', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();

    messaging.beginBulkMessageIngest(DRAIN);
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
    });
    await systemEvent(ctx, messaging.messageReactions, PEER, 'edit_message', {
      messageId: 'm1',
      newContent: 'rewritten',
      editedAt: 4_000,
    });
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    expect(envelopeBodyText(shown(conversations)[0].content)).toBe('rewritten');
    expect(shown(conversations)[0].isEdited).toBe(true);
    expect(envelopeBodyText(store.rows.get('m1').content)).toBe('rewritten');
    expect(store.rows.get('m1')).toMatchObject({ isEdited: true, editedAt: 4_000 });
  });

  it("drops it when the editor is not the body's author", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    messaging.beginBulkMessageIngest(DRAIN);
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, { messageId: 'm1' });
    await systemEvent(ctx, messaging.messageReactions, OTHER, 'edit_message', {
      messageId: 'm1',
      newContent: 'forged',
      editedAt: 4_000,
    });
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    expect(envelopeBodyText(shown(conversations)[0].content)).toBe('original');
    expect(store.rows.get('m1').isEdited).toBeUndefined();
  });
});

describe('a reaction whose message is not shown', () => {
  it('is merged into the STORED row', async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    store.rows.set('m1', storedBody());

    await reactionFrame(ctx, messaging.messageReactions, OTHER, 'm1');

    expect(store.rows.get('m1').reactions).toEqual([
      expect.objectContaining({ userId: OTHER, emoji: '👍' }),
    ]);
  });

  it('lands with the body when both came in one drain', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, store } = makeContext();

    messaging.beginBulkMessageIngest(DRAIN);
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, { messageId: 'm1' });
    await reactionFrame(ctx, messaging.messageReactions, OTHER, 'm1');
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    const expected = [expect.objectContaining({ userId: OTHER, emoji: '👍' })];
    expect(shown(conversations)[0].reactions).toEqual(expected);
    expect(store.rows.get('m1').reactions).toEqual(expected);
  });
});

describe('a body re-delivered for a stored row memory does not show', () => {
  it('never writes over a stored TOMBSTONE - not through a batch, not live', async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    store.rows.set('m1', storedBody({ isDeleted: true, content: m.chat_system_message_deleted() }));
    store.rows.set('m2', storedBody({ id: 'm2', isDeleted: true, content: 'deleted' }));

    // A broadcast or join bundle restating old history goes through the batch.
    await messaging.batchAddMessages(
      [{ senderId: PEER, content: BODY, messageId: 'm1' }],
      CONVO,
      ctx,
      'restore'
    );
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, { messageId: 'm2' });

    expect(store.rows.get('m1')).toMatchObject({ isDeleted: true });
    expect(store.rows.get('m1').content).toBe(m.chat_system_message_deleted());
    expect(store.rows.get('m2')).toMatchObject({ isDeleted: true, content: 'deleted' });
  });

  it("keeps a stored row's edit and reactions, and leaves a row it cannot open alone", async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    const reacted = [{ userId: OTHER, emoji: '👍', at: 1 }];
    store.rows.set('m1', storedBody({ isEdited: true, editedAt: 3, reactions: reacted }));
    store.unreadable.add('m3');

    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: BODY, messageId: 'm1' },
        { senderId: PEER, content: BODY, messageId: 'm3' },
      ],
      CONVO,
      ctx,
      'restore'
    );

    expect(store.rows.get('m1')).toMatchObject({ isEdited: true, reactions: reacted });
    expect(store.rows.has('m3')).toBe(false);
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it('settles a stored tombstone written before its message, at the message’s own time', async () => {
    const messaging = useMessaging();
    const { ctx, store } = makeContext();
    store.rows.set(
      'm1',
      storedBody({ isDeleted: true, deletedBeforeArrival: true, content: 'x', timestamp: 9_000 })
    );

    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, {
      messageId: 'm1',
      serverTimestamp: 2_000,
      timestamp: new Date(1_500),
    });

    expect(store.rows.get('m1')).toMatchObject({
      isDeleted: true,
      content: 'x',
      serverTimestamp: 2_000,
      deletedBeforeArrival: false,
    });
    expect(store.rows.get('m1').timestamp).not.toBe(9_000);
  });
});
