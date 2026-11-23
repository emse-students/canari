// @vitest-environment happy-dom
/**
 * A REACTION TO MY MESSAGE WHILE THE APP IS OPEN ON ANOTHER SCREEN NOTIFIED NOBODY (owner,
 * 2026-11-17): the push is dropped in the foreground on both phones, and a reaction had no second
 * trigger. `notifyInboundReaction` is that trigger; these pin that it is raised whenever the
 * conversation is off screen - never deferring to a push that may itself be dropped - and carries the
 * reaction's instant, which makes its post and the push's ONE notification.
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
let NARROW = true;
vi.mock('$lib/utils/viewport', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isNarrowChatLayout: () => NARROW,
}));
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
  at: 1_700_000_000_123,
  removed: false,
  changed: true,
  messageAuthorId: ME,
  authorLookupFailed: false,
  live: true,
};

/** The phone's own on-screen fact (`__canariForeground`); absent off the phone shells. */
function foreground(value: boolean | undefined) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const w = window as unknown as Record<string, unknown>;
  if (value === undefined) delete w.__canariForeground;
  else w.__canariForeground = value;
  delete w.__canariActive;
}

describe('the frame trigger of a reaction to my message', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/posts');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    MOBILE = true;
    NARROW = true;
  });

  it('THE DEFECT: the app open on another screen is told, with the actor and the emoji', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);

    messaging.notifyInboundReaction(REACTION, ctx);

    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
    expect(sendReactionNotification).toHaveBeenCalledWith({
      conversationId: CONVO,
      messageId: 'msg-1',
      actorId: PEER,
      actorName: 'Peer',
      emoji: '❤️',
      at: 1_700_000_000_123,
    });
  });

  it('NEVER A LOSS: a phone not in front still posts it - the push of the same reaction is made ONE with it', async () => {
    // Round 2 of the review: deferring to the push here, then a push landing after the user came
    // back (and dropped as foreground), announced it NOWHERE. Both post now; `at` makes them one.
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(false);

    messaging.notifyInboundReaction(REACTION, ctx);

    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
    expect(sendReactionNotification.mock.calls[0][0].at).toBe(1_700_000_000_123);
  });

  it('leaves a frame without its instant to the push on a phone, and says so', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);

    messaging.notifyInboundReaction({ ...REACTION, at: 0 }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('it carries no instant, so it cannot be told apart from its push')
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

  /**
   * A REACTION NEVER ANNOUNCES LOUDER THAN A MESSAGE WOULD IN THE SAME PLACE (coordinator, 2026-11-23,
   * principle 3). Each case asks the message path's own predicate through the same runtime, so the
   * two cannot drift: a banner for the reaction exactly where a message would raise one.
   */
  it.each([
    // [what is on screen, route, selected, narrow, a message there raises a banner]
    [
      'phone, a salon left with Back (the salon list does not draw it)',
      '/communities',
      '',
      true,
      true,
    ],
    ['phone, the chat list after Back (its row would light up)', '/chat', '', true, false],
    ['phone, that conversation open', '/chat', CONVO, true, false],
    ['phone, another conversation open', '/chat', 'other', true, true],
    ['wide, reading another conversation beside the list', '/chat', 'other', false, false],
    ['wide, that conversation open', '/chat', CONVO, false, false],
    ['wide, another page entirely', '/posts', 'other', false, true],
  ])(
    '%s: a notification exactly where a message would raise one',
    async (_what, path, selected, narrow, banner) => {
      NARROW = narrow;
      MOBILE = narrow;
      const messaging = useMessaging();
      const { ctx, sendReactionNotification } = makeContext(selected);
      window.history.pushState({}, '', path);
      foreground(true);
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      // A person at the desktop window (a phone is exempt from the attention term).
      const { windowAttention } = await import('$lib/utils/windowAttention.svelte');
      windowAttention.noteGesture();
      const { canSeeArrivalNow } = await import('$lib/utils/chat/arrivalRuntime');
      // The message path's answer for the same place, through the same runtime.
      expect(!canSeeArrivalNow(CONVO, selected)).toBe(banner);

      messaging.notifyInboundReaction(REACTION, ctx);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(sendReactionNotification).toHaveBeenCalledTimes(banner ? 1 : 0);
    }
  );

  it('an iPhone that is no longer ACTIVE is told, even with that conversation open (the app switcher)', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext(CONVO);
    window.history.pushState({}, '', '/chat');
    foreground(true);
    (window as unknown as Record<string, unknown>).__canariActive = false;

    messaging.notifyInboundReaction(REACTION, ctx);

    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
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

  it('WARNS each reaction whose author the STORE failed to give - a real unknown', async () => {
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = { ...REACTION, messageAuthorId: null, authorLookupFailed: true };

    messaging.notifyInboundReaction(failed, ctx);
    messaging.notifyInboundReaction(failed, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('whether it is to my message is unknown')
    );
  });

  it('says ONCE per session, never per heart, a frame naming no author on a message held nowhere', async () => {
    // A reactor predating `target_author_id`, in a salon this device never drew: every heart there
    // reads this way, mine or not.
    const messaging = useMessaging();
    const { ctx, sendReactionNotification } = makeContext();
    foreground(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 3; i++) {
      messaging.notifyInboundReaction({ ...REACTION, messageAuthorId: null }, ctx);
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReactionNotification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left to the push alone'));
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
