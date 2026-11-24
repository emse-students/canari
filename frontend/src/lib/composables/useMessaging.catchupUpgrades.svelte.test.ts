/**
 * THE UPGRADES A CATCH-UP HOLDS (review of #4054): since the bulk window holds push-preview
 * upgrades for its flush, the flush is their only relay to the other tabs, and a reaction or an edit
 * that reaches the preview inside the same drain must survive the upgrade - on screen and at rest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      conversationKey: string,
      convo: Parameters<typeof real.notificationSenderName>[2]
    ) => real.notificationSenderName(senderId, conversationKey, convo),
    resolveDisplayNames: async () => (id: string) => id,
  };
});

/** Breaks the `useMessaging` -> outbox -> `globalChatSingleton` import cycle (see bulkIngest test). */
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const published = vi.hoisted(
  () => [] as Array<{ type: string; messages?: { id: string; content: string }[] }>
);
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>();
  return {
    ...real,
    publishTabMessageUpdate: (event: (typeof published)[number]) => published.push(event),
  };
});

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { ChatMessage, Conversation } from '$lib/types';
import type { StoredMessage } from '$lib/db/types';
import { mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import { mergeRelayedBatch } from '$lib/utils/chat/messageMerge';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };
const BODY = serializeEnvelope(mkTextEnvelope('the original words'));

/** A store holding rows by id, with the compare-and-set `mergeMessages` the batch's upgrade uses. */
function makeContext(stored: StoredMessage[], shown: ChatMessage[]) {
  const rows = new Map(stored.map((row) => [row.id, row]));
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: shown, unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: CONVO,
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    storage: {
      saveMessagesIfAbsent: vi.fn(async (incoming: StoredMessage[]) => {
        const written = new Set<string>();
        for (const row of incoming) {
          if (rows.has(row.id)) continue;
          rows.set(row.id, row);
          written.add(row.id);
        }
        return written;
      }),
      getMessagesByIds: vi.fn(async () => ({ rows: new Map(), unreadable: new Set() })),
      mergeMessages: vi.fn(
        async (
          _c: string,
          ids: readonly string[],
          merge: (r: StoredMessage) => StoredMessage | null
        ) => {
          const done = new Set<string>();
          for (const id of ids) {
            const current = rows.get(id);
            const next = current ? merge(current) : null;
            if (next) {
              rows.set(id, next);
              done.add(id);
            }
          }
          return done;
        }
      ),
      getPendingMutations: vi.fn(async () => ({ entries: [], unreadable: 0 })),
    } as never,
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
  return { ctx, conversations, rows };
}

const PREVIEW_AT = 1_700_000_000_000;
const previewShown = (): ChatMessage => ({
  id: 'p-1',
  senderId: PEER,
  content: 'the original words',
  timestamp: new Date(PREVIEW_AT),
  isOwn: false,
  isFcmPreview: true,
});
const previewStored = (): StoredMessage =>
  ({
    id: 'p-1',
    conversationId: CONVO,
    senderId: PEER,
    content: 'the original words',
    timestamp: PREVIEW_AT,
    isFcmPreview: true,
  }) as StoredMessage;

describe('a catch-up holding a preview upgrade', () => {
  beforeEach(() => {
    published.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('relays the upgraded row to the other tabs with the new ones, and a follower takes the body', async () => {
    const messaging = useMessaging();
    const { ctx } = makeContext([previewStored()], [previewShown()]);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, { messageId: 'p-1', frameId: 'f-1' });
    await messaging.addMessageToChat(PEER, serializeEnvelope(mkTextEnvelope('new')), CONVO, ctx, {
      messageId: 'n-1',
      frameId: 'f-2',
      serverTimestamp: PREVIEW_AT + 1000,
    });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    const batch = published.find((e) => e.type === 'messages_batch');
    expect(batch?.messages?.map((m) => m.id).sort()).toEqual(['n-1', 'p-1']);
    expect(batch?.messages?.find((m) => m.id === 'p-1')?.content).toBe(BODY);

    // The follower, which still shows the caption, takes the body and the new row.
    const follower = mergeRelayedBatch([previewShown()], batch!.messages as ChatMessage[]);
    expect(follower?.map((m) => m.id)).toEqual(['p-1', 'n-1']);
    expect(follower?.[0].content).toBe(BODY);
    expect(follower?.[0].isFcmPreview).toBe(false);
  });

  it('keeps a reaction and an edit that reached the preview inside the same window', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, rows } = makeContext([previewStored()], [previewShown()]);
    const reaction = { emoji: '👍', userId: ME, at: PREVIEW_AT + 10 };
    const editedAt = PREVIEW_AT + 20;

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, BODY, CONVO, ctx, { messageId: 'p-1', frameId: 'f-1' });
    // The reaction frame and the author's edit frame of the same drain land on the preview shown and
    // stored (what `applyReactionFrame` and the edit handler write), before the window's close.
    const row = conversations.get(CONVO)!;
    conversations.set(CONVO, {
      ...row,
      messages: [
        {
          ...row.messages[0],
          reactions: [reaction],
          content: 'the edited words',
          isEdited: true,
          editedAt: new Date(editedAt),
        },
      ],
    });
    rows.set('p-1', {
      ...rows.get('p-1')!,
      reactions: [reaction],
      content: 'the edited words',
      isEdited: true,
      editedAt,
    });

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    const shownNow = conversations.get(CONVO)!.messages[0];
    expect(shownNow.isFcmPreview).toBe(false);
    expect(shownNow.content).toContain('the edited words');
    expect(shownNow.content).not.toBe('the edited words'); // a body, not the caption
    expect(shownNow.reactions).toEqual([reaction]);
    const storedNow = rows.get('p-1')!;
    expect(storedNow.isFcmPreview).toBe(false);
    expect(storedNow.content).toContain('the edited words');
    expect(storedNow.isEdited).toBe(true);
    expect(storedNow.reactions).toEqual([reaction]);
  });
});

describe('mergeRelayedBatch', () => {
  it('inserts what the follower lacks, upgrades a shown preview, leaves the rest, and says when nothing changed', () => {
    const body: ChatMessage = { ...previewShown(), content: BODY, isFcmPreview: false };
    const held: ChatMessage = { ...previewShown(), id: 'h-1', content: BODY, isFcmPreview: false };
    expect(mergeRelayedBatch([held], [held])).toBeNull();
    const merged = mergeRelayedBatch([previewShown(), held], [body]);
    expect(merged?.find((m) => m.id === 'p-1')?.content).toBe(BODY);
    expect(merged?.find((m) => m.id === 'h-1')).toBe(held);
  });
});
