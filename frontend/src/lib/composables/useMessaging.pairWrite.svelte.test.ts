/**
 * AN OWN MESSAGE AND ITS OUTBOX ENTRY ARE ONE WRITE, AND WHAT BECAME OF IT IS REPORTED, NEVER
 * INFERRED (review of #2843, M1).
 *
 * `addMessageToChat` swallowed a failed `saveMessageWithOutboxEntry` into a log line, and the send
 * path then told the outbox the row was already on disk (`alreadyDurable`) - so nothing wrote it and
 * the message was never sent. It now calls `onPairWritten` only after the write, and throws a
 * `MessagePairWriteError` when the write failed - once the conversation and the echo are saved, so
 * the page still shows the message the outbox is about to queue on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as the other useMessaging tests: useMessaging -> chat/outbox ->
// chat/outboxMirror -> globalChatSingleton, which calls useMessaging() at module scope.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');
const { MessagePairWriteError } = await import('$lib/utils/chat/messageWrittenError');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';

const ME = 'me-user-id';
const CONVO = 'conversation-key';

function makeContext(saveMessageWithOutboxEntry: () => Promise<void>) {
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const saveConversation = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: CONVO,
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessageWithOutboxEntry: vi.fn(saveMessageWithOutboxEntry),
    } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation,
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return { ctx, conversations, saveConversation };
}

const entry = { id: 'm1', conversationId: CONVO, kind: 'text' } as unknown as OutboxEntry;

describe('addMessageToChat reports the pair write', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls onPairWritten once the message and its entry are on disk', async () => {
    const messaging = useMessaging();
    const { ctx } = makeContext(async () => {});
    const onPairWritten = vi.fn();
    await messaging.addMessageToChat(ME, 'hello', CONVO, ctx, {
      messageId: 'm1',
      status: 'pending',
      outboxEntry: entry,
      onPairWritten,
    });
    expect(onPairWritten).toHaveBeenCalledOnce();
  });

  it('THROWS a MessagePairWriteError when the write failed - never a silent success', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveConversation } = makeContext(async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const onPairWritten = vi.fn();
    const added = messaging.addMessageToChat(ME, 'hello', CONVO, ctx, {
      messageId: 'm1',
      status: 'pending',
      outboxEntry: entry,
      onPairWritten,
    });
    await expect(added).rejects.toBeInstanceOf(MessagePairWriteError);
    await expect(added).rejects.toMatchObject({ messageId: 'm1' });
    expect(onPairWritten).not.toHaveBeenCalled();
    // The echo is still on screen and its conversation saved: the outbox queues it on its own.
    expect(conversations.get(CONVO)?.messages.map((m) => m.id)).toEqual(['m1']);
    expect(saveConversation).toHaveBeenCalled();
  });
});
