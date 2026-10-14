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
  fetchNotificationPreferences: vi.fn(),
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
    api.fetchNotificationPreferences.mockResolvedValue({ disabled: ['messages'], groupLevels: {} });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    await useMessaging().addMessageToChat(PEER, 'hello', 'conv-1', ctx, { messageId: 'm2' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('keeps notifying a salon when only "messages" is off', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({ disabled: ['messages'], groupLevels: {} });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('channel_abc');
    await useMessaging().addMessageToChat(PEER, 'hello', 'channel_abc', ctx, { messageId: 'm3' });
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('is silent for a salon when "channels" is off', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({ disabled: ['channels'], groupLevels: {} });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('channel_abc');
    await useMessaging().addMessageToChat(PEER, 'hello', 'channel_abc', ctx, { messageId: 'm4' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});

describe("a private conversation's level gates the notification this client raises", () => {
  const ME64 = 'a'.repeat(64);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    notificationPreferences.reset();
    hideTheTab();
  });

  async function arrive(level: 'all' | 'mentions' | 'none', text: string, id: string) {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: level === 'all' ? {} : { 'conv-1': level },
    });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    (ctx as { userId: string }).userId = ME64;
    await useMessaging().addMessageToChat(PEER, text, 'conv-1', ctx, { messageId: id });
    return sendSystemNotification;
  }

  it('raises nothing at none, even for a mention', async () => {
    expect(await arrive('none', `hey @[${ME64}]`, 'l1')).not.toHaveBeenCalled();
  });

  it('raises a mention of this account at mentions', async () => {
    expect(await arrive('mentions', `hey @[${ME64}]`, 'l2')).toHaveBeenCalledTimes(1);
  });

  it('raises nothing at mentions for a message naming nobody, or somebody else', async () => {
    expect(await arrive('mentions', 'hello', 'l3')).not.toHaveBeenCalled();
    expect(await arrive('mentions', `hey @[${'b'.repeat(64)}]`, 'l4')).not.toHaveBeenCalled();
  });

  it('at mentions, a catch-up flush raises ONE banner when ANY of its messages names me', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { 'conv-1': 'mentions' },
    });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    (ctx as { userId: string }).userId = ME64;
    await useMessaging().batchAddMessages(
      [
        { senderId: PEER, content: `@[${ME64}] look`, messageId: 'b1' },
        { senderId: PEER, content: 'ok', messageId: 'b2' },
        { senderId: PEER, content: 'lol', messageId: 'b3' },
      ],
      'conv-1',
      ctx,
      'arrival'
    );
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    // The banner is the last message; the mention it stands for picks the mentions channel.
    expect(sendSystemNotification.mock.calls[0][3]).toBe(true);
  });

  it('at mentions, a catch-up flush naming nobody raises nothing', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { 'conv-1': 'mentions' },
    });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('conv-1');
    (ctx as { userId: string }).userId = ME64;
    await useMessaging().batchAddMessages(
      [
        { senderId: PEER, content: 'ok', messageId: 'b4' },
        { senderId: PEER, content: 'lol', messageId: 'b5' },
      ],
      'conv-1',
      ctx,
      'arrival'
    );
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('looks the level up by the GROUP id, so a DM keyed me::peer obeys it', async () => {
    const GROUP = '0b9f3d7e-1111-4222-8333-444455556666';
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { [GROUP]: 'none' },
    });
    await notificationPreferences.load();
    const key = 'me::peer';
    const { ctx, sendSystemNotification } = makeContext(key);
    const row = ctx.conversations.get(key)!;
    ctx.conversations.set(key, { ...row, id: GROUP });
    await useMessaging().addMessageToChat(PEER, 'hello', key, ctx, { messageId: 'l6' });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('leaves a salon to its own level - its key is channel_', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { channel_abc: 'none' },
    });
    await notificationPreferences.load();
    const { ctx, sendSystemNotification } = makeContext('channel_abc');
    await useMessaging().addMessageToChat(PEER, 'hello', 'channel_abc', ctx, { messageId: 'l5' });
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });
});
