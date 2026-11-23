// @vitest-environment happy-dom
/**
 * THE DECISION IS RE-MADE AT THE POST, ON THE LIVE SELECTION (reviews of #3985).
 *
 * `notifyInbound` decides, then awaits the sender's name and two mirror flushes before it hands the
 * post over; the poster awaits again (permission, the announcement claim). Between the decision and
 * the post the reader can come back in front - the receipt effect then hands over `read_here`, which
 * retires the banners, so one posted after it stays up - or move to ANOTHER conversation, which
 * `ctx.selectedContact` (a snapshot) does not see. So the caller hands the poster a live re-ask
 * (`stillOwed`, read on `ctx.selectedNow()`), which the poster runs last before posting
 * (`useNotifications.readerNowSees`; the poster's half is pinned in
 * `useNotifications.iosAnnounced.svelte.test.ts`). These pin the caller's half: what that re-ask
 * answers at the post's instant, in every direction.
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
const A = 'conversation-a';
const C = 'conversation-c';

function convo(key: string): Conversation {
  return {
    id: key,
    name: key,
    contactName: key,
    conversationType: 'direct',
    messages: [],
    unreadCount: 0,
    lastMessageAt: 0,
  } as never;
}

/** A context whose snapshot is `selected` and whose LIVE selection is whatever `live.now` says. */
function makeContext(selected: string) {
  const live = { now: selected as string | null };
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const sendReactionNotification = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    conversations: new SvelteMap<string, Conversation>([
      [A, convo(A)],
      [C, convo(C)],
    ]),
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: selected,
    selectedNow: () => live.now,
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
  return { ctx, live, sendSystemNotification, sendReactionNotification };
}

const w = window as unknown as Record<string, unknown>;

/** The re-ask the poster was handed - the 6th argument of a message post, the 2nd of a reaction's. */
const reaskOf = (mock: ReturnType<typeof vi.fn>, index: number) =>
  mock.mock.calls[0][index] as () => boolean;

const REACTION: InboundReaction = {
  conversationKey: A,
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

describe('the live re-ask handed to the poster', () => {
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
    w.__canariActive = true;
  });

  it('back in front on that conversation before the post: no longer owed', async () => {
    w.__canariActive = false; // the home gesture, A left open
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext(A);
    await messaging.addMessageToChat(PEER, 'their message', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    const stillOwed = reaskOf(sendSystemNotification, 5);
    expect(stillOwed()).toBe(true);
    w.__canariActive = true; // didBecomeActive
    expect(stillOwed()).toBe(false);
  });

  it('THE LOST POST: away on A, back on C through its banner - A is still owed, though the snapshot says A', async () => {
    w.__canariActive = false;
    const messaging = useMessaging();
    const { ctx, live, sendSystemNotification } = makeContext(A);
    await messaging.addMessageToChat(PEER, 'their message', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    const stillOwed = reaskOf(sendSystemNotification, 5);
    w.__canariActive = true;
    live.now = C; // the reader tapped C's banner meanwhile
    expect(ctx.selectedContact).toBe(A);
    expect(stillOwed()).toBe(true);
  });

  it('THE STALE BANNER: in front on C, a message in A, then A opened before the post - no longer owed', async () => {
    const messaging = useMessaging();
    const { ctx, live, sendSystemNotification } = makeContext(C);
    await messaging.addMessageToChat(PEER, 'their message', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    const stillOwed = reaskOf(sendSystemNotification, 5);
    expect(stillOwed()).toBe(true);
    live.now = A;
    expect(stillOwed()).toBe(false);
  });

  it('a reaction carries the same live re-ask, both directions', async () => {
    const messaging = useMessaging();
    const { ctx, live, sendReactionNotification } = makeContext(C);
    messaging.notifyInboundReaction(REACTION, ctx);
    await vi.waitFor(() => expect(sendReactionNotification).toHaveBeenCalledTimes(1));
    const stillOwed = reaskOf(sendReactionNotification, 1);
    expect(stillOwed()).toBe(true);
    live.now = A;
    expect(stillOwed()).toBe(false);
    live.now = C;
    w.__canariActive = false;
    expect(stillOwed()).toBe(true);
  });
});
