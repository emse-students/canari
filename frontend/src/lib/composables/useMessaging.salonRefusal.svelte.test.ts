/**
 * A SALON TEXT IS SHOWN AT ONCE, AND A REFUSAL NEVER MAKES IT VANISH (WP-OFF-1, WP-OFF-2).
 *
 * The salon has no durable queue: the text lives in a local echo row (`awaitingServerId`) that the
 * server's answer settles, or marks `error` with a retry. `handleSendChat` answers `true` once the
 * text is safe in a row - whether or not the server took it - and `false` only when NO row could be
 * drawn, which is when the page puts the draft back in the composer.
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

const rows = (ctx: MessagingContext) => ctx.conversations.get(CHANNEL)!.messages;

describe('a salon text send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('shows the row at once and re-keys it to the server id on the answer', async () => {
    let answer: (id: string) => void = () => {};
    sendMock.mockImplementation(() => new Promise<string>((resolve) => (answer = resolve)));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    const done = messaging.handleSendChat(ctx, 'hello');
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    // In flight: the row is there, under the client id, flagged and `sending`.
    expect(rows(ctx)).toHaveLength(1);
    const [echo] = rows(ctx);
    expect(echo.awaitingServerId).toBe(true);
    expect(echo.status).toBe('sending');
    expect(echo.id).toBe(sendMock.mock.calls[0][2]);

    answer('server-row-1');
    expect(await done).toBe(true);

    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'server-row-1', status: 'sent' });
    expect(rows(ctx)[0].awaitingServerId).toBeUndefined();
    expect(ctx.playSendTone).toHaveBeenCalledTimes(1);
  });

  it('keeps the text in a failed row, raises the error, and retries the same message', async () => {
    sendMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    // `true`: the text is safe in a row, so the page must NOT also put it back in the composer.
    expect(await messaging.handleSendChat(ctx, 'hello')).toBe(true);
    expect(vi.mocked(ctx.setSendError).mock.calls.at(-1)?.[0]).toBeTruthy();
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ status: 'error', awaitingServerId: true });
    const localId = rows(ctx)[0].id;

    sendMock.mockResolvedValueOnce('server-row-2');
    await messaging.retrySend(ctx, localId);

    // Same client id sent again (it is what the broadcast frame is matched on), one row left.
    expect(sendMock.mock.calls[1][2]).toBe(localId);
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'server-row-2', status: 'sent' });
  });

  it('a failed row can be discarded', async () => {
    sendMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'hello');

    messaging.discardSend(ctx, rows(ctx)[0].id);

    expect(rows(ctx)).toHaveLength(0);
  });
});
