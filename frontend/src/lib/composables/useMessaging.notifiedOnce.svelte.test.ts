// @vitest-environment happy-dom
/**
 * A MESSAGE IS ANNOUNCED ONCE ON A DEVICE, WHATEVER CARRIED IT AND HOWEVER OFTEN.
 *
 * Measured on an iPhone 12, `1.5.4-alpha.1`, 2026-11-01. The notification extension decrypted and
 * presented "K2 group killed 0724" while the app was killed; the tap launched the app, the cold
 * start pulled the row again (a push acknowledges nothing), and `notifyInbound` - seeing a message
 * the empty map did not hold - said `[NOTIF] Inbound in ... while the app is open on /posts showing
 * the list - asking.` and presented it a second time. A background tap did the same to "T1 group bg
 * tap" on the resume that followed it.
 *
 * Two facts make a message already announced, both by ID: the app raised a banner for it (the
 * durable record, `notifiedMessages.ts`), or the extension did (its push cache). Each case below
 * fails with either half removed.
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
  isMobileTauriRuntime: () => true,
}));

/** What the extension wrote into the push cache and the app has not taken yet. */
let presentedByExtension = new Set<string>();
vi.mock('$lib/utils/chat/fcmCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushCacheMessageIds: async () => presentedByExtension,
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };

/** A fresh session's view: the conversation row exists and holds no message - a cold start's map. */
function coldStart() {
  const sendSystemNotification = vi.fn().mockResolvedValue(true);
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'something-else',
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
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { messaging: useMessaging(), ctx, sendSystemNotification };
}

/** On screen, on another page - the state of the iPhone at 07:28:33 (`/posts`, the list). */
function inTheForegroundElsewhere() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  (window as unknown as Record<string, unknown>).__canariForeground = true;
  window.history.pushState({}, '', '/posts');
}

/** Lets the decision's async half (the cache read, the sender name) run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a message is announced once on a device', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    presentedByExtension = new Set();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    inTheForegroundElsewhere();
  });

  it('THE DEFECT: the extension presented it, the cold start drains it again - nothing is raised', async () => {
    presentedByExtension = new Set(['k2']);
    const { messaging, ctx, sendSystemNotification } = coldStart();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'K2 group killed 0724', CONVO, ctx, {
      messageId: 'k2',
    });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    await settle();

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('and after the take erased it from the cache, the record still knows it', async () => {
    // The take records the ids before it acknowledges the files (`consumeFcmCache`); a redelivery
    // after that finds the cache empty and the record answering.
    presentedByExtension = new Set(['t1']);
    const first = coldStart();
    await first.messaging.addMessageToChat(PEER, 'T1 group bg tap', CONVO, first.ctx, {
      messageId: 't1',
    });
    await settle();
    presentedByExtension = new Set();
    const second = coldStart();
    await second.messaging.addMessageToChat(PEER, 'T1 group bg tap', CONVO, second.ctx, {
      messageId: 't1',
    });
    await settle();

    expect(first.sendSystemNotification).not.toHaveBeenCalled();
    expect(second.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('a message the APP announced is not announced again by the next session', async () => {
    const first = coldStart();
    await first.messaging.addMessageToChat(PEER, 'hello', CONVO, first.ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(first.sendSystemNotification).toHaveBeenCalledTimes(1));

    // The process died before the acknowledgement landed: the next launch is handed it again.
    const second = coldStart();
    await second.messaging.addMessageToChat(PEER, 'hello', CONVO, second.ctx, {
      messageId: 'm-1',
    });
    await settle();

    expect(second.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('THE CONTROL: a new message is still announced, and a flush with one new message among known ones too', async () => {
    presentedByExtension = new Set(['old']);
    const { messaging, ctx, sendSystemNotification } = coldStart();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'already shown', CONVO, ctx, { messageId: 'old' });
    await messaging.addMessageToChat(PEER, 'brand new', CONVO, ctx, { messageId: 'new' });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    // The one banner stands for the one message it announces, not for the two the flush carried.
    expect(sendSystemNotification.mock.calls[0][4]).toMatchObject({ covers: 1 });
  });

  it('a banner that was NOT raised (throttled, refused, thrown) leaves its message announceable', async () => {
    const first = coldStart();
    first.sendSystemNotification.mockResolvedValue(false);
    await first.messaging.addMessageToChat(PEER, 'hello', CONVO, first.ctx, { messageId: 'm-t' });
    await vi.waitFor(() => expect(first.sendSystemNotification).toHaveBeenCalledTimes(1));
    await settle();

    const second = coldStart();
    second.sendSystemNotification.mockRejectedValue(new Error('plugin threw'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await second.messaging.addMessageToChat(PEER, 'hello', CONVO, second.ctx, { messageId: 'm-t' });
    await vi.waitFor(() => expect(second.sendSystemNotification).toHaveBeenCalledTimes(1));
    await settle();

    // Nothing was shown either time, so the next delivery still announces it.
    const third = coldStart();
    await third.messaging.addMessageToChat(PEER, 'hello', CONVO, third.ctx, { messageId: 'm-t' });
    await vi.waitFor(() => expect(third.sendSystemNotification).toHaveBeenCalledTimes(1));
  });

  it('two decisions about one message racing across the cache read raise ONE banner', async () => {
    // Both pass the first check before either reads the push cache; the claim made after that read,
    // in the same tick as a second check, is what lets only one of them through.
    const a = coldStart();
    const b = coldStart();
    await Promise.all([
      a.messaging.addMessageToChat(PEER, 'twice', CONVO, a.ctx, { messageId: 'race' }),
      b.messaging.addMessageToChat(PEER, 'twice', CONVO, b.ctx, { messageId: 'race' }),
    ]);
    await settle();
    await settle();
    expect(
      a.sendSystemNotification.mock.calls.length + b.sendSystemNotification.mock.calls.length
    ).toBe(1);
  });
});
