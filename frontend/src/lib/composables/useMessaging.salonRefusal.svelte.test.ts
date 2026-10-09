/**
 * A REFUSED SALON SEND TELLS ITS CALLER SO THE DRAFT CAN COME BACK (WP-OFF-1).
 *
 * A salon message has no bubble and no queue entry: when the server does not take it, the text
 * lives nowhere but the composer the click just emptied. `handleSendChat` therefore answers `false`
 * on a refusal and puts the reply target back; the page restores the text from that answer.
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

const sendMock = vi.fn();
vi.mock('$lib/utils/chat/channelCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/channelCrypto')>();
  return { ...actual, sendEncryptedChannelMessage: (...a: unknown[]) => sendMock(...a) };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const CHANNEL = 'channel_12cf41f3-0000-0000-0000-000000000000';

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CHANNEL,
      { id: CHANNEL, name: CHANNEL, messages: [], unreadCount: 0, lastMessageAt: 0 } as never,
    ],
  ]);
  return {
    conversations,
    userId: 'me',
    authToken: 't',
    selectedContact: CHANNEL,
    setAuthToken: vi.fn(),
    setSendError: vi.fn(),
    playSendTone: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

describe('a salon text send answers whether the server took it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('answers false and raises the error when the POST fails', async () => {
    sendMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    expect(await messaging.handleSendChat(ctx, 'hello')).toBe(false);
    expect(vi.mocked(ctx.setSendError).mock.calls.at(-1)?.[0]).toBeTruthy();
    expect(ctx.playSendTone).not.toHaveBeenCalled();
  });

  it('answers true when the server took it', async () => {
    sendMock.mockResolvedValue(undefined);
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    expect(await messaging.handleSendChat(ctx, 'hello')).toBe(true);
    expect(ctx.playSendTone).toHaveBeenCalledTimes(1);
  });
});
