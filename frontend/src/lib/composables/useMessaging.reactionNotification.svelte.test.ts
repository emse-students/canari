// @vitest-environment happy-dom
/**
 * A REACTION TO MY MESSAGE WHILE THE APP IS OPEN ON ANOTHER SCREEN NOTIFIED NOBODY (owner,
 * 2026-11-17): the push is dropped in the foreground on both phones, and a reaction had no second
 * trigger. `notifyInboundReaction` is that trigger; these pin it from both directions - raised where
 * the push is dropped, NEVER raised where the push draws, so one reaction is never announced twice.
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

let MOBILE = true;
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => MOBILE,
}));

const { useMessaging } = await import('./useMessaging.svelte');
const { notificationPreferences } = await import('$lib/stores/notificationPreferences.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { InboundReaction } from '$lib/utils/chat/reactionNotification';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

function makeContext(lookingAt = 'something-else') {
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
    selectedContact: lookingAt,
    log: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
    sendReactionNotification,
  } as unknown as MessagingContext;
  return { ctx, sendReactionNotification };
}

const REACTION: InboundReaction = {
  conversationKey: CONVO,
  messageId: 'msg-1',
  reactorId: PEER,
  emoji: '❤️',
  removed: false,
  changed: true,
  messageAuthorId: ME,
  live: true,
};

/** The phone's own foreground fact - the one its push handler reads too. */
function foreground(value: boolean | undefined) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  if (value === undefined) delete (window as unknown as Record<string, unknown>).__canariForeground;
  else (window as unknown as Record<string, unknown>).__canariForeground = value;
}

describe('the frame trigger of a reaction to my message', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    MOBILE = true;
  });

  it('THE DEFECT: the app open on another screen is told, with the actor and the emoji', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);

    messaging.notifyInboundReaction(REACTION, ctx);

    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
    expect(sendReactionNotification).toHaveBeenCalledWith({
      conversationId: CONVO,
      actorId: PEER,
      actorName: 'Peer',
      emoji: '❤️',
    });
  });

  it('NEVER DOUBLES THE PUSH: a phone not in the foreground is left to the push', async () => {
    // Exactly the state in which Android's `dispatchPush` and iOS `CanariHandleFcmData` draw it.
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(false);

    messaging.notifyInboundReaction(REACTION, ctx);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('the app is not in the foreground - the push draws it')
    );
  });

  it('NEVER DOUBLES THE PUSH: a catch-up frame on resume is not announced again', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);

    messaging.notifyInboundReaction({ ...REACTION, live: false }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while that very conversation is on screen', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext(CONVO);
    window.history.pushState({}, '', '/chat');
    foreground(true);

    messaging.notifyInboundReaction(REACTION, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
  });

  it("obeys the account's reactions switch", async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);
    vi.spyOn(notificationPreferences, 'pushAllowed').mockImplementation(
      (category) => category !== 'reactions'
    );

    messaging.notifyInboundReaction(REACTION, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
  });

  it("obeys the conversation's level: a reaction is never a mention", async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);
    vi.spyOn(notificationPreferences, 'groupLevel').mockReturnValue('mentions');

    messaging.notifyInboundReaction(REACTION, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
  });

  it('says nothing about a reaction to somebody else - the ordinary frame', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);

    messaging.notifyInboundReaction({ ...REACTION, messageAuthorId: PEER }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[NOTIF] Reaction'));
  });

  it('web and desktop have no push, so a hidden tab is told', async () => {
    MOBILE = false;
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext(CONVO);
    window.history.pushState({}, '', '/chat');
    foreground(undefined);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });

    messaging.notifyInboundReaction(REACTION, ctx);

    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
  });
});
