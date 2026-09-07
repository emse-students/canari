/**
 * TAB-1: A HIDDEN TAB WAS TOLD ABOUT NOTHING, because only one of the two inbound paths could speak.
 *
 * The decision to raise an OS notification lived inside `addMessageToChat`. While a catch-up is
 * draining, that function files an INBOUND message into the bulk buffer and returns above the
 * decision, and the flush hands it to `batchAddMessages` - which never had one. A backgrounded tab
 * is exactly the state that produces a drain, so the case the feature exists for was the case it
 * could not serve: TAB-1 recorded permission `granted`, the tab hidden, the message arrived, and
 * zero notifications constructed (2026-09-05).
 *
 * Both paths now ask `notifyInbound`, and these pin both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle cut as `useMessaging.bulkIngest.svelte.test.ts` - see its comment.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));
// Every case here is the WEB client, whose rule is "hidden OR unfocused". Native mobile has its own
// condition and its own file (`useMessaging.mobileNotification`): it notifies only on `hidden`,
// because a WebView reporting no focus while its activity is on screen would interrupt a reader.
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => false,
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };

/**
 * `lookingAt` IS A FIXTURE PARAMETER SINCE 2026-09-07: "the tab is visible and focused" stopped
 * being the whole question. A visible window sitting on another route, or on a narrow layout
 * showing a different conversation, can see nothing of this arrival - `arrivalVisibility.ts` owns
 * the rule and asserts every cell. The default stays `something-else`.
 */
function makeContext(lookingAt = 'something-else') {
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    // Not the open conversation: a hidden tab showing this very thread is a different question.
    selectedContact: lookingAt,
    // BOTH writers, because the two inbound paths use different ones: the live path saves one
    // message and the bulk flush saves the batch. A fixture with only the first made
    // `batchAddMessages` log a real TypeError into every drain case - harmless to the assertion,
    // and exactly the kind of red herring a later reader spends an hour on.
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
    } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    getChatContainer: () => undefined,
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { ctx, conversations, sendSystemNotification };
}

/** The state a backgrounded tab is in, and the only one this feature is for. */
function hideTheTab(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(!hidden);
}

describe('a hidden tab is notified on both inbound paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('THE DEFECT: a message buffered by a catch-up still raises one when it is flushed', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    hideTheTab(true);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    // Buffered: nothing has reached the user yet, and that part is correct.
    expect(sendSystemNotification).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification.mock.calls[0][2]).toBe(CONVO);
  });

  it('one per flush, not one per message - a catch-up must not become a burst', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    hideTheTab(true);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    for (const id of ['a', 'b', 'c']) {
      await messaging.addMessageToChat(PEER, `message ${id}`, CONVO, ctx, { messageId: id });
    }
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('the live path still raises one, which is the half that always worked', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    hideTheTab(true);

    await messaging.addMessageToChat(PEER, 'live message', CONVO, ctx, { messageId: 'live-1' });
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('a VISIBLE, focused tab READING THAT CONVERSATION is told nothing on either path', async () => {
    const messaging = useMessaging();
    // "The user is looking at it" now has to be stated rather than inferred from the tab being in
    // front: a focused window on another route sees this arrival nowhere and IS notified.
    const { ctx, sendSystemNotification } = makeContext(CONVO);
    hideTheTab(false);

    await messaging.addMessageToChat(PEER, 'live message', CONVO, ctx, { messageId: 'live-2' });
    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'buffered', CONVO, ctx, { messageId: 'buf-1' });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('and neither path announces the user their own message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    hideTheTab(true);

    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'own-1' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});
