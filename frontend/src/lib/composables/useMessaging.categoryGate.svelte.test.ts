/**
 * THE ACCOUNT'S "MESSAGES" / "COMMUNITY CHANNELS" SWITCH, honoured by the notifications this client
 * raises ITSELF from a socket frame. The server already refuses to push a muted category, but a
 * frame that arrives over the WebSocket raises its notification here with no push involved, so a
 * client-only gap would leave the setting half-working. Same fixture as
 * `useMessaging.hiddenNotification`.
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
const api = vi.hoisted(() => ({
  fetchDisabledCategories: vi.fn(),
  saveDisabledCategories: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);

const { useMessaging } = await import('./useMessaging.svelte');
const { notificationPreferences } = await import('$lib/stores/notificationPreferences.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';

function makeContext(key: string) {
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [key, { id: key, name: key, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
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
  return { ctx, sendSystemNotification };
}

function hideTheTab() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
}

describe('a switched-off category raises no local notification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    notificationPreferences.reset();
    hideTheTab();
  });

  it('notifies a conversation message by default', async () => {
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    await useMessaging().addMessageToChat(PEER, 'hello', 'conv-1', ctx, { messageId: 'm1' });
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('is silent for a conversation when "messages" is off', async () => {
    api.fetchDisabledCategories.mockResolvedValue(['messages']);
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    await useMessaging().addMessageToChat(PEER, 'hello', 'conv-1', ctx, { messageId: 'm2' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('keeps notifying a salon when only "messages" is off', async () => {
    api.fetchDisabledCategories.mockResolvedValue(['messages']);
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('channel_abc');
    await useMessaging().addMessageToChat(PEER, 'hello', 'channel_abc', ctx, { messageId: 'm3' });
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('is silent for a salon when "channels" is off', async () => {
    api.fetchDisabledCategories.mockResolvedValue(['channels']);
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('channel_abc');
    await useMessaging().addMessageToChat(PEER, 'hello', 'channel_abc', ctx, { messageId: 'm4' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});
