// @vitest-environment happy-dom
/**
 * A BANNER DECIDED WHILE THE READER WAS AWAY, POSTED AFTER THEY CAME BACK, STAYED UP (review of #3985).
 *
 * `notifyInbound` decides, then awaits the sender's name and two mirror flushes before it posts. An
 * iPhone that becomes active again in between (`didBecomeActive`) runs the receipt effect, which hands
 * over `read_here` and so retires the conversation's banners - BEFORE this one is posted, so nothing
 * ever retired it. The decision is now re-made on the facts of the post's own instant. These pin both
 * directions: the reader back in front raises nothing, the reader still away is told once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

let releaseName: (name: string) => void = () => {};
vi.mock('$lib/utils/users/displayName', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/users/displayName')>()),
  resolveNotificationSenderName: () =>
    new Promise<string>((resolve) => {
      releaseName = resolve;
    }),
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
vi.mock('$lib/utils/viewport', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isNarrowChatLayout: () => true,
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { InboundReaction } from '$lib/utils/chat/reactionNotification';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

function makeContext() {
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const sendReactionNotification = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        contactName: CONVO,
        conversationType: 'direct',
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    // THE CONVERSATION IS OPEN: what decides is only whether the app is in front of the reader.
    selectedContact: CONVO,
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
    sendSystemNotification,
    sendReactionNotification,
  } as unknown as MessagingContext;
  return { ctx, sendSystemNotification, sendReactionNotification };
}

const w = window as unknown as Record<string, unknown>;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const REACTION: InboundReaction = {
  conversationKey: CONVO,
  messageId: 'msg-1',
  reactorId: PEER,
  emoji: '❤️',
  at: 1_700_000_000_123,
  removed: false,
  changed: true,
  messageAuthorId: ME,
  authorLookupFailed: false,
  live: true,
};

describe('the decision is re-made at the post', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/chat');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    w.__canariForeground = true;
    // The home gesture: the app is no longer active, its background edge not there yet.
    w.__canariActive = false;
  });

  it('THE RACE: back in front before the post - nothing is posted that nothing would retire', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-1' });
    // `didBecomeActive` lands while the sender's name is still being asked for.
    w.__canariActive = true;
    releaseName('Peer');
    await settle();

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('still away at the post: told exactly once', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-1' });
    releaseName('Peer');
    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
  });

  it('the reaction post follows the same rule', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();

    messaging.notifyInboundReaction(REACTION, ctx);
    w.__canariActive = true;
    releaseName('Peer');
    await settle();
    expect(sendReactionNotification).not.toHaveBeenCalled();

    w.__canariActive = false;
    messaging.notifyInboundReaction({ ...REACTION, at: REACTION.at + 1 }, ctx);
    releaseName('Peer');
    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
  });
});
