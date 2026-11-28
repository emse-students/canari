// @vitest-environment happy-dom
/**
 * TWO ADDS FOR ONE CONVERSATION MAY INTERLEAVE, AND BOTH MESSAGES ARE KEPT.
 *
 * `addMessageToChatOnce` is not serialized per conversation: the MLS drain applies one frame at a
 * time, but a send, an own notice and the outbox's lines call `addMessageToChat` outside it. An
 * inbound add reads the conversation, then awaits the store (`getMessagesByIds`); it used to render
 * by spreading that ENTRY copy, which erased from memory whatever another writer showed in the gap
 * - an own message just sent, another arrival, and its unread count. It now renders onto the row as
 * it is after its last await, as the batch path and the upgrade path already did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/users/displayName')>()),
  resolveNotificationSenderName: async () => 'Peer',
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => false,
}));

// The account's settings, answered: this file is not about them (`test/answeredPreferences.ts`).
vi.mock('$lib/notifications/preferencesApi', async (orig) =>
  (await import('../../test/answeredPreferences')).answeringTheDefault(orig)
);
const { useMessaging } = await import('./useMessaging.svelte');
await (await import('../../test/answeredPreferences')).answerPreferences();
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const A = 'conversation-a';

/** A context on A, the reader elsewhere, whose store read of `held` waits for `release()`. */
function heldRead(held: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const getMessagesByIds = vi.fn(async (_key: string, ids: string[]) => {
    if (ids.includes(held)) await gate;
    return { rows: new Map(), unreadable: new Set<string>() };
  });
  const ctx = {
    conversations: new SvelteMap<string, Conversation>([
      [
        A,
        {
          id: A,
          name: A,
          contactName: A,
          conversationType: 'direct',
          messages: [],
          unreadCount: 0,
          lastMessageAt: 0,
        } as never,
      ],
    ]),
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: null,
    selectedNow: () => null,
    storage: {
      getMessagesByIds,
      saveMessagesIfAbsent: vi.fn(
        async (rows: { id: string }[]) => new Set(rows.map((row) => row.id))
      ),
      saveMessageWithOutboxEntry: vi.fn().mockResolvedValue(undefined),
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
  return { ctx, getMessagesByIds, release };
}

const idsOf = (ctx: MessagingContext) => ctx.conversations.get(A)?.messages.map((m) => m.id) ?? [];
const unreadOf = (ctx: MessagingContext) => ctx.conversations.get(A)?.unreadCount ?? 0;

describe('two adds for one conversation interleave across the store read', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The reader is on another route: every inbound message is unread.
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a second arrival lands while the first awaits the store - both kept, both counted', async () => {
    const messaging = useMessaging();
    const { ctx, getMessagesByIds, release } = heldRead('m-1');
    const first = messaging.addMessageToChat(PEER, 'first', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalled());

    await messaging.addMessageToChat(PEER, 'second', A, ctx, { messageId: 'm-2' });
    expect(idsOf(ctx)).toEqual(['m-2']);
    expect(unreadOf(ctx)).toBe(1);

    release();
    await first;

    expect(new Set(idsOf(ctx))).toEqual(new Set(['m-1', 'm-2']));
    expect(unreadOf(ctx)).toBe(2);
  });

  it('an own message sent while an arrival awaits the store is not erased by it', async () => {
    const messaging = useMessaging();
    const { ctx, getMessagesByIds, release } = heldRead('m-1');
    const arrival = messaging.addMessageToChat(PEER, 'theirs', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalled());

    await messaging.addMessageToChat(ME, 'mine', A, ctx, {
      messageId: 'own-1',
      outboxEntry: { id: 'own-1' } as never,
    });
    expect(idsOf(ctx)).toEqual(['own-1']);

    release();
    await arrival;

    expect(new Set(idsOf(ctx))).toEqual(new Set(['m-1', 'own-1']));
    expect(unreadOf(ctx)).toBe(1);
  });

  it('the same id shown by another writer meanwhile is not shown twice', async () => {
    const messaging = useMessaging();
    const { ctx, getMessagesByIds, release } = heldRead('m-1');
    const first = messaging.addMessageToChat(PEER, 'same', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalledTimes(1));
    // A redelivery of the same frame through a second writer: its own store read is held too.
    const second = messaging.addMessageToChat(PEER, 'same', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalledTimes(2));

    release();
    await Promise.all([first, second]);

    expect(idsOf(ctx)).toEqual(['m-1']);
  });
});
