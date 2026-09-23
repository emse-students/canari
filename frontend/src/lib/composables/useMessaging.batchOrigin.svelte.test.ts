/**
 * A REPLAYED ARCHIVE IS NOT AN ARRIVAL, AND ONLY THE CALLER CAN TELL THEM APART.
 *
 * `batchAddMessages` raises one OS notification per flush, for the last inbound message in it. It
 * decides that from `brandNew`, which means "not already in the in-memory map" - and on a cold start
 * the map is being filled for the first time, so EVERY message a peer hands back counts as brand
 * new. The `[HISTORY_BUNDLE]` path in `systemMessageHandler` hands back exactly that: another
 * member's archive, sent because this device asked for history. So at every launch the last message
 * of the archive was announced again, including the one whose notification the user had already
 * read and swiped away.
 *
 * Reported 2026-09-18 (`G2`): *"une notification que j'ai ignoree se raffiche au lancement de
 * l'app"*. The report named the launch, which is the tell - a dismissal only has to survive until
 * the next one.
 *
 * The distinction is not derivable inside `batchAddMessages`: an archived message and a live one are
 * the same row, and the only difference is where it came from, which every caller knows and used to
 * discard at the door. Hence `MessageBatchOrigin`, required rather than defaulted.
 *
 * WHAT THIS DOES NOT COVER. The Android half - a message REDELIVERED over the wire because the app
 * was never awake to acknowledge its push - is a different mechanism, in the native builder, and is
 * pinned by `dismissedNotificationReplay.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as the other useMessaging suites: useMessaging -> chat/outbox ->
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
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

/**
 * The conversation is deliberately NOT the selected one and the document is hidden, so
 * `canSeeArrival` is false and a notification is genuinely expected for an arrival. Without that,
 * both cases would be silent and the test would pass for the wrong reason.
 */
function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        contactName: 'Camille',
        conversationType: 'direct',
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
      } as never,
    ],
  ]);
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'some-other-conversation',
    storage: { saveMessages: vi.fn().mockResolvedValue(undefined) } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { ctx, sendSystemNotification };
}

const messages = (prefix: string) => [
  { senderId: PEER, content: 'first', messageId: `${prefix}-1` },
  { senderId: PEER, content: 'second', messageId: `${prefix}-2` },
];

describe('what a batch of messages IS decides whether it notifies', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Hidden, so the reader cannot see the arrival land and a notification is expected.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  });

  it('announces an arrival - the case the notification exists for', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();

    await messaging.batchAddMessages(messages('a'), CONVO, ctx, 'arrival');

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a restore, however new the rows look to this device', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();

    await messaging.batchAddMessages(messages('r'), CONVO, ctx, 'restore');

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('still stores and renders a restore - silence is about the notification only', async () => {
    const messaging = useMessaging();
    const { ctx } = makeContext();

    await messaging.batchAddMessages(messages('s'), CONVO, ctx, 'restore');

    expect(ctx.conversations.get(CONVO)?.messages).toHaveLength(2);
  });

  it('says why it raised nothing, because a silent drop is the thing being fixed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx } = makeContext();

    await messaging.batchAddMessages(messages('l'), CONVO, ctx, 'restore');

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[NOTIF]') && l.includes('not an arrival'))).toBe(true);
  });
});
