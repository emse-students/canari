/**
 * A SELECTION IS NOT A SCREEN: a salon "open" in the store is not a salon being read.
 *
 * `selectedContact` is a global singleton, and leaving `/communities` for `/posts` does not clear
 * it. Both inbound paths asked only `selectedContact === key`, so for as long as the app lived that
 * salon counted every arrival as read on the spot: no unread badge, and the read signal sent to the
 * server - which clears this account's notification on its OTHER devices - for a message nobody
 * had seen. The same held for a hidden tab or an unfocused window. Measured on the local estate
 * 2026-10-10: reader on `/posts` with a salon still selected, title count unchanged, one
 * `POST /read` on the wire, no `read-mark`.
 *
 * The rule is `readerIsReadingConversation` (selected, app in front, a route that draws a
 * conversation); these cases pin that both inbound paths and the read signal ask it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

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
  isMobileTauriRuntime: () => false,
}));

const { useMessaging } = await import('./useMessaging.svelte');
const { resetChannelReadSignals } = await import('$lib/utils/chat/channelReadSignal');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const SALON = 'channel_00000000-0000-4000-8000-000000000001';

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [SALON, { id: SALON, name: SALON, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const signalChannelRead = vi.fn();
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    // THE SALON IS THE SELECTED CONVERSATION in every case: only where the reader is differs.
    selectedContact: SALON,
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
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
    signalChannelRead,
  } as unknown as MessagingContext;
  return { ctx, conversations, signalChannelRead };
}

/** Where the reader is, and whether the window is in front of them. */
function reader(pathname: string, inFront = true) {
  window.history.pushState({}, '', pathname);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (inFront ? 'visible' : 'hidden'),
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(inFront);
}

const unread = (conversations: SvelteMap<string, Conversation>) =>
  conversations.get(SALON)?.unreadCount ?? 0;

describe('a selected salon is read on arrival only where it is on screen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetChannelReadSignals();
  });

  it('CONTROL: on /communities, in front - read on arrival, the siblings are told', async () => {
    reader('/communities');
    const messaging = useMessaging();
    const { ctx, conversations, signalChannelRead } = makeContext();

    await messaging.addMessageToChat(PEER, 'hello', SALON, ctx, { messageId: 'm-1' });

    expect(unread(conversations)).toBe(0);
    expect(signalChannelRead).toHaveBeenCalledTimes(1);
  });

  it('THE DEFECT: the selection outlived a visit to /posts - the message is UNREAD, nothing is signalled', async () => {
    reader('/posts');
    const messaging = useMessaging();
    const { ctx, conversations, signalChannelRead } = makeContext();

    await messaging.addMessageToChat(PEER, 'hello', SALON, ctx, { messageId: 'm-2' });

    expect(unread(conversations)).toBe(1);
    expect(signalChannelRead).not.toHaveBeenCalled();
  });

  it('a hidden tab is not reading either, even on the right route', async () => {
    reader('/communities', false);
    const messaging = useMessaging();
    const { ctx, conversations, signalChannelRead } = makeContext();

    await messaging.addMessageToChat(PEER, 'hello', SALON, ctx, { messageId: 'm-3' });

    expect(unread(conversations)).toBe(1);
    expect(signalChannelRead).not.toHaveBeenCalled();
  });

  it('the batch path asks the same question', async () => {
    reader('/posts');
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    await messaging.batchAddMessages(
      [{ senderId: PEER, content: 'one', messageId: 'b-1', timestamp: new Date() }],
      SALON,
      ctx,
      'arrival'
    );

    expect(unread(conversations)).toBe(1);
  });

  it('and the batch path still reads it on arrival where the reader is', async () => {
    reader('/communities');
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    await messaging.batchAddMessages(
      [{ senderId: PEER, content: 'one', messageId: 'b-2', timestamp: new Date() }],
      SALON,
      ctx,
      'arrival'
    );

    expect(unread(conversations)).toBe(0);
  });
});
