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

/** A salon's notification level is a server read; every salon is `all` here. */
vi.mock('$lib/notifications/preferencesApi', async (orig) => ({
  ...(await orig<typeof import('$lib/notifications/preferencesApi')>()),
  fetchChannelNotificationLevel: async () => 'all' as const,
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

/**
 * THE DECISION ITSELF IS LIVE TOO (final review of #3985). `addMessageToChat` and
 * `batchAddMessages` read the store (`getMessagesByIds`) BEFORE they decide whether the reader sees
 * the arrival, and the context's `selectedContact` is the selection from when they were entered.
 * A reader who moved from A to C during that read was judged "on A": a tone instead of a
 * notification, and the message read on arrival - announced zero times, read unseen.
 */
describe('the arrival decision reads the selection after the row read, not before', () => {
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

  /** A context on A whose store read is held open until `release()`. */
  function heldOnA() {
    const made = makeContext(A);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getMessagesByIds = vi.fn(async () => {
      await gate;
      return { rows: new Map(), unreadable: new Set<string>() };
    });
    Object.assign(made.ctx.storage as object, {
      getMessagesByIds,
      saveMessagesIfAbsent: vi.fn(async (rows: unknown[]) => rows),
    });
    return { ...made, getMessagesByIds, release };
  }

  const unreadOf = (ctx: MessagingContext, key: string) =>
    ctx.conversations.get(key)?.unreadCount ?? 0;

  it('THE SINGLE PATH: the reader moves to C during the row read - A is notified and stays unread', async () => {
    const messaging = useMessaging();
    const { ctx, live, getMessagesByIds, release, sendSystemNotification } = heldOnA();
    const adding = messaging.addMessageToChat(PEER, 'their message', A, ctx, {
      messageId: 'm-1',
    });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalled());
    live.now = C; // the reader opened C while the store answered
    release();
    await adding;

    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    expect(ctx.playReceiveTone).not.toHaveBeenCalled();
    expect(unreadOf(ctx, A)).toBe(1);
  });

  it('THE BATCH PATH: the same move during the batch read - A is notified and stays unread', async () => {
    const messaging = useMessaging();
    const { ctx, live, getMessagesByIds, release, sendSystemNotification } = heldOnA();
    const adding = messaging.batchAddMessages(
      [{ senderId: PEER, content: 'their message', messageId: 'm-1' }],
      A,
      ctx,
      'arrival'
    );
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalled());
    live.now = C;
    release();
    await adding;

    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    expect(ctx.playReceiveTone).not.toHaveBeenCalled();
    expect(unreadOf(ctx, A)).toBe(1);
  });

  it('CONTROL: the reader stays on A - read on arrival, a tone, no notification', async () => {
    const messaging = useMessaging();
    const { ctx, getMessagesByIds, release, sendSystemNotification } = heldOnA();
    const adding = messaging.addMessageToChat(PEER, 'their message', A, ctx, {
      messageId: 'm-1',
    });
    await vi.waitFor(() => expect(getMessagesByIds).toHaveBeenCalled());
    release();
    await adding;

    await vi.waitFor(() => expect(ctx.playReceiveTone).toHaveBeenCalled());
    expect(sendSystemNotification).not.toHaveBeenCalled();
    expect(unreadOf(ctx, A)).toBe(0);
  });
});

/**
 * ONE ARRIVAL VERDICT, TAKEN AFTER THE ROW'S WRITE (review of #3985). The single path decided the
 * read on arrival BEFORE writing the row, and the tone and the notification after it: a reader who
 * backed out while the write was in flight got the message counted read on arrival (no unread; for
 * a salon, the read signal that clears the banners on their other devices) AND a banner here. The
 * write is held open while the reader leaves: every effect must read the one later verdict.
 */
describe('the read on arrival, the read signal, the tone and the notification read one verdict', () => {
  const SALON = 'channel_00000000-0000-4000-8000-0000000000aa';

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

  /**
   * A context on `selected` whose row write (`saveMessagesIfAbsent`) is held open until `release()`;
   * `during` runs while it is held - the reader's move.
   */
  function writeHeldOn(selected: string) {
    const made = makeContext(selected);
    made.ctx.conversations.set(SALON, { ...convo(SALON), conversationType: 'channel' } as never);
    const signalChannelRead = vi.fn();
    Object.assign(made.ctx, { signalChannelRead });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saveMessagesIfAbsent = vi.fn(async (rows: { id: string }[]) => {
      await gate;
      return new Set(rows.map((row) => row.id));
    });
    Object.assign(made.ctx.storage as object, {
      getMessagesByIds: vi.fn(async () => ({ rows: new Map(), unreadable: new Set<string>() })),
      saveMessagesIfAbsent,
    });
    return { ...made, saveMessagesIfAbsent, release, signalChannelRead };
  }

  const unreadOf = (ctx: MessagingContext, key: string) =>
    ctx.conversations.get(key)?.unreadCount ?? 0;

  it('THE DEFECT: on A, the home gesture during the write - unread AND notified, read nowhere', async () => {
    const messaging = useMessaging();
    const { ctx, saveMessagesIfAbsent, release, sendSystemNotification } = writeHeldOn(A);
    const adding = messaging.addMessageToChat(PEER, 'their message', A, ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(saveMessagesIfAbsent).toHaveBeenCalled());
    w.__canariActive = false; // the reader left while the row was being written
    release();
    await adding;

    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    expect(unreadOf(ctx, A)).toBe(1);
    expect(ctx.playReceiveTone).not.toHaveBeenCalled();
  });

  it('THE DEFECT, a salon: Back during the write - unread, notified, and NO read signal', async () => {
    window.history.pushState({}, '', '/communities');
    const messaging = useMessaging();
    const { ctx, live, saveMessagesIfAbsent, release, sendSystemNotification, signalChannelRead } =
      writeHeldOn(SALON);
    const adding = messaging.addMessageToChat(PEER, 'their message', SALON, ctx, {
      messageId: 'm-2',
      skipDbSave: false,
    });
    await vi.waitFor(() => expect(saveMessagesIfAbsent).toHaveBeenCalled());
    live.now = null; // Back: the salon list, the salon no longer open
    release();
    await adding;

    await vi.waitFor(() => expect(sendSystemNotification).toHaveBeenCalledTimes(1));
    expect(unreadOf(ctx, SALON)).toBe(1);
    expect(signalChannelRead).not.toHaveBeenCalled();
    expect(ctx.playReceiveTone).not.toHaveBeenCalled();
  });

  it('CONTROL: the reader stays on the salon through the write - read, signalled, a tone, no notification', async () => {
    window.history.pushState({}, '', '/communities');
    const messaging = useMessaging();
    const { ctx, saveMessagesIfAbsent, release, sendSystemNotification, signalChannelRead } =
      writeHeldOn(SALON);
    const adding = messaging.addMessageToChat(PEER, 'their message', SALON, ctx, {
      messageId: 'm-3',
      skipDbSave: false,
    });
    await vi.waitFor(() => expect(saveMessagesIfAbsent).toHaveBeenCalled());
    release();
    await adding;

    expect(unreadOf(ctx, SALON)).toBe(0);
    expect(signalChannelRead).toHaveBeenCalledTimes(1);
    expect(ctx.playReceiveTone).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});
