// @vitest-environment happy-dom
/**
 * OUT OF FRONT ON AN iPHONE, THE SERVER ANNOUNCES (`appActive.ts`).
 *
 * A salon message is pushed to every member and the notification extension raises its banner, so
 * the page raising one too was the second banner: silent while the app is inactive. A private
 * conversation's queued frame is not consumed at all while inactive, so the only one that reaches
 * the decision began decrypting while active, was ACKed, and gets no push: the page still raises
 * its banner. And `isAppInForeground()` - read by ten other consumers - is not what decides.
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
  isIosTauriRuntime: () => true,
}));

vi.mock('$lib/utils/chat/fcmCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushCacheMessageIds: async () => new Set<string>(),
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const PEER = 'peer-user-id';
const DM = 'conversation-key';
const SALON = 'channel_salon-1';

function session(key: string) {
  const sendSystemNotification = vi.fn().mockResolvedValue(true);
  const ctx = {
    conversations: new SvelteMap<string, Conversation>([
      [key, { id: key, name: key, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
    ]),
    userId: 'me-user-id',
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a banner while the iPhone app is inactive', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.history.pushState({}, '', '/posts');
    const w = window as unknown as Record<string, unknown>;
    // The other consumers' flag says "in front": the banner must not read it.
    w.__canariForeground = true;
    w.__canariActive = false;
  });

  it('A SALON is silent - its push announces it', async () => {
    const s = session(SALON);
    await s.messaging.addMessageToChat(PEER, 'hello salon', SALON, s.ctx, { messageId: 's-1' });
    await settle();
    await settle();
    expect(s.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('A PRIVATE MESSAGE that reached the decision (began while active, ACKed, never pushed) is announced by the page', async () => {
    const s = session(DM);
    await s.messaging.addMessageToChat(PEER, 'hello', DM, s.ctx, { messageId: 'm-1' });
    await vi.waitFor(() => expect(s.sendSystemNotification).toHaveBeenCalledTimes(1));
  });
});
