/**
 * A BULK FLUSH MERGES INTO THE ROW AS IT IS WHEN IT WRITES, NOT AS IT WAS WHEN IT STARTED.
 *
 * `batchAddMessages` yields to the main thread every 50 messages. The boot restore now asks for the
 * frames it refused as soon as the conversation rows exist (`notifyConversationRowsSeeded`), so a
 * drain's flush and the restore's stored-page merge can interleave at exactly that yield. The flush
 * used to write back the row it read before its loop, erasing the page the restore had merged in
 * between. The yield is the seam, so the test stands on it: the restore's write happens INSIDE it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation, ChatMessage } from '$lib/types';

/** What runs inside the next yield - the restore's write, in the one test that sets it. */
let duringYield: (() => void) | null = null;

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn(async () => {
    const run = duringYield;
    duringYield = null;
    run?.();
  }),
}));

/**
 * The sender lookup a notification waits on is a profile read (`/api/users/batch`) nothing here is
 * about: it answers from the cache, offline, as the synchronous form does.
 */
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

/** A message the restore read from the store - older than every arrival. */
const STORED: ChatMessage = {
  id: 'stored-1',
  senderId: PEER,
  content: 'from the store',
  timestamp: new Date(1_000),
  isOwn: false,
} as ChatMessage;

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
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

/** Buffers `n` inbound messages, newer than `STORED`, through the drain window. */
async function bufferArrivals(
  messaging: ReturnType<typeof useMessaging>,
  ctx: MessagingContext,
  n: number
) {
  messaging.beginBulkMessageIngest(DRAIN);
  for (let i = 0; i < n; i += 1) {
    await messaging.addMessageToChat(PEER, `arrival ${i}`, CONVO, ctx, {
      messageId: `arrival-${i}`,
      serverTimestamp: 10_000 + i,
    });
  }
}

describe('a bulk flush that yields while the restore writes the row', () => {
  beforeEach(() => {
    duringYield = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps the stored page the restore merged in during the yield', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    await bufferArrivals(messaging, ctx, 60);

    // Fires at the 50th message of the flush loop - the yield the defect lived in.
    duringYield = () => {
      const row = conversations.get(CONVO)!;
      conversations.set(CONVO, { ...row, messages: [STORED, ...row.messages] });
    };
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    const ids = (conversations.get(CONVO)?.messages ?? []).map((m) => m.id);
    expect(ids).toContain('stored-1');
    expect(ids.filter((id) => id.startsWith('arrival-'))).toHaveLength(60);
    expect(ids).toHaveLength(61);
  });

  it('does not add twice a message the row gained during the yield', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    await bufferArrivals(messaging, ctx, 60);

    // The restore's page already carries one of the arrivals (persisted by an earlier drain).
    duringYield = () => {
      const row = conversations.get(CONVO)!;
      const again = {
        id: 'arrival-59',
        senderId: PEER,
        content: 'arrival 59',
        timestamp: new Date(10_059),
        isOwn: false,
      } as ChatMessage;
      conversations.set(CONVO, { ...row, messages: [STORED, again] });
    };
    await messaging.endBulkMessageIngest(ctx, DRAIN);

    const ids = (conversations.get(CONVO)?.messages ?? []).map((m) => m.id);
    expect(ids.filter((id) => id === 'arrival-59')).toHaveLength(1);
    expect(ids).toHaveLength(61);
  });
});
