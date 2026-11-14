/**
 * BOTH ADD PATHS COUNT AT THE READ POINT A LOAD DERIVES FROM (`countingReadPoint`), so the live `+1`
 * is exactly what the next cold start re-derives. Before 2026-11-11 they asked the saved marks
 * alone: with no mark, a late row the server held before my own newest reply raised a badge the next
 * load would not, and a row the upgrade's local seed covered raised one too. Map: chat.md, "A DM's
 * unread count is derived from its read point at every load (2026-11-11)".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation, ChatMessage } from '$lib/types';

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn(async () => {}),
}));

/** The sender lookup a notification waits on answers from the cache, offline. */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      conversationKey: string,
      convo: Parameters<typeof real.notificationSenderName>[2]
    ) => real.notificationSenderName(senderId, conversationKey, convo),
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
const CONVO = 'conversation-key';
const DRAIN = { bufferUi: true, showOverlay: false };

/** My own reply on the row, which the server dated 2000. No read mark anywhere. */
const MY_REPLY: ChatMessage = {
  id: 'reply-1',
  senderId: ME,
  content: 'my reply',
  timestamp: new Date(2_000),
  serverTimestamp: 2_000,
  isOwn: true,
} as ChatMessage;

function makeContext(row: Partial<Conversation> = {}) {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        lifecycle: 'active',
        messages: [MY_REPLY],
        unreadCount: 0,
        lastMessageAt: 0,
        ...row,
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: '',
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
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
  return { ctx, conversations };
}

/** One inbound row the server dated `serverAt`, through the single path or a drain's batch. */
async function receive(
  path: 'single' | 'batch',
  serverAt: number,
  row: Partial<Conversation> = {}
) {
  const messaging = useMessaging();
  const { ctx, conversations } = makeContext(row);
  if (path === 'batch') messaging.beginBulkMessageIngest(DRAIN);
  await messaging.addMessageToChat(PEER, `at ${serverAt}`, CONVO, ctx, {
    messageId: `m-${serverAt}`,
    serverTimestamp: serverAt,
  });
  if (path === 'batch') await messaging.endBulkMessageIngest(ctx, DRAIN);
  return conversations.get(CONVO)?.unreadCount;
}

describe.each(['single', 'batch'] as const)('the %s add path counts at the read point', (path) => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('counts a row after my own newest reply, the control', async () => {
    expect(await receive(path, 2_500)).toBe(1);
  });

  it('does not count a late row the server holds before my own newest reply', async () => {
    expect(await receive(path, 1_500)).toBe(0);
  });

  it("does not count a row the upgrade's local seed covers", async () => {
    expect(await receive(path, 2_800, { messages: [], localReadSeed: 3_000 })).toBe(0);
  });
});
