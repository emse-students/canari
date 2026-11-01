/**
 * A SYSTEM NOTICE IS NOT CONVERSATION ACTIVITY, A CALL RECORD IS (user, 2026-10-27).
 *
 * "X added a device" moved its conversation to the top of the list. Every writer of the
 * `lastMessageAt` seed goes through `advanceLastMessageAt`; this drives the two real writers
 * (`addMessageToChat`, `batchAddMessages`) and the sidebar key with a notice and with a call record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      convo: Parameters<typeof real.notificationSenderName>[1]
    ) => real.notificationSenderName(senderId, convo),
  };
});

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
import type { Conversation } from '$lib/types';
import { conversationRecency } from '$lib/utils/chat/conversations';
import { mkCallStartedEnvelope, serializeEnvelope } from '$lib/envelope';

const CONVO = 'conversation-key';
const NOTICE = 'a device was added';
const CALL = serializeEnvelope(mkCallStartedEnvelope('Camille', 'call-1', 'camille', 5_000));

function makeContext(seed?: number) {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        ...(seed !== undefined ? { lastMessageAt: seed } : {}),
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId: 'me-user-id',
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'some-other-conversation',
    storage: { saveMessage: vi.fn().mockResolvedValue(undefined) } as never,
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
  return { ctx, conversations };
}

describe('the seed and the sidebar key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('single add: a notice leaves the seed alone, a real message moves it', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext(100);
    await messaging.addMessageToChat('system', NOTICE, CONVO, ctx, {
      isSystem: true,
      messageId: 'n1',
      timestamp: new Date(900),
    });
    expect(conversations.get(CONVO)?.lastMessageAt).toBe(100);
    await messaging.addMessageToChat('peer', 'hello', CONVO, ctx, {
      messageId: 'm1',
      timestamp: new Date(300),
    });
    expect(conversations.get(CONVO)?.lastMessageAt).toBe(300);
    expect(conversationRecency(conversations.get(CONVO)!)).toBe(300);
  });

  it('batch: a notice-only batch leaves the seed alone and an unseeded row unseeded', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    await messaging.batchAddMessages(
      [
        {
          senderId: 'system',
          content: NOTICE,
          messageId: 'n1',
          timestamp: new Date(900),
        },
      ],
      CONVO,
      ctx,
      'arrival'
    );
    expect(conversations.get(CONVO)?.lastMessageAt).toBeUndefined();
    expect(conversationRecency({ ...conversations.get(CONVO)!, startedAt: 40 })).toBe(40);
  });

  it('a call record DOES count as activity', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext(100);
    await messaging.addMessageToChat('system', CALL, CONVO, ctx, {
      isSystem: true,
      messageId: 'call-row',
      timestamp: new Date(700),
    });
    expect(conversations.get(CONVO)?.lastMessageAt).toBe(700);
    expect(conversationRecency(conversations.get(CONVO)!)).toBe(700);
  });
});
