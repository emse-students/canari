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
import { ApiRefusalError } from '$lib/utils/apiRefusal';

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
    sendMock.mockReset();
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('shows the row at once and re-keys it to the server id on the answer', async () => {
    let answer: (row: { id: string; serverMs?: number }) => void = () => {};
    sendMock.mockImplementation(
      () => new Promise<{ id: string; serverMs?: number }>((resolve) => (answer = resolve))
    );
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

    answer({ id: 'server-row-1', serverMs: 1_000 });
    expect(await done).toBe(true);

    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({
      id: 'server-row-1',
      status: 'sent',
      serverTimestamp: 1_000,
    });
    expect(rows(ctx)[0].awaitingServerId).toBeUndefined();
    expect(ctx.playSendTone).toHaveBeenCalledTimes(1);
  });

  it('keeps the text in a failed row, raises the error, and retries the same message', async () => {
    // A 4xx IS AN ANSWER: the server saw the request and refused it, so the row is failed.
    sendMock.mockRejectedValueOnce(new ApiRefusalError(422, null, 'refused'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    // `true`: the text is safe in a row, so the page must NOT also put it back in the composer.
    expect(await messaging.handleSendChat(ctx, 'hello')).toBe(true);
    expect(vi.mocked(ctx.setSendError).mock.calls.at(-1)?.[0]).toBeTruthy();
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ status: 'error', awaitingServerId: true });
    const localId = rows(ctx)[0].id;

    sendMock.mockResolvedValueOnce({ id: 'server-row-2' });
    await messaging.retrySend(ctx, localId);

    // Same client id sent again (it is what the broadcast frame is matched on), one row left.
    expect(sendMock.mock.calls[1][2]).toBe(localId);
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'server-row-2', status: 'sent' });
  });

  it('a transport failure is an UNKNOWN outcome: the row is unconfirmed, never failed', async () => {
    sendMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.handleSendChat(ctx, 'unknown outcome');

    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ status: 'unconfirmed', awaitingServerId: true });
    expect(vi.mocked(ctx.setSendError).mock.calls.at(-1)?.[0]).toBeTruthy();
    // ...and the text is still owed to the member should this page die before anything settles it.
    const { takeOrphanedSalonTexts } = await import('$lib/utils/chat/salonUnsent');
    expect(await takeOrphanedSalonTexts('me', CHANNEL, new Set())).toEqual([
      expect.objectContaining({ text: 'unknown outcome' }),
    ]);
  });

  it('keeps the text in the unsent ledger until the server answers, then forgets it', async () => {
    let answer: (row: { id: string; serverMs?: number }) => void = () => {};
    sendMock.mockImplementation(
      () => new Promise<{ id: string; serverMs?: number }>((resolve) => (answer = resolve))
    );
    const { useMessaging } = await import('./useMessaging.svelte');
    const { takeOrphanedSalonTexts } = await import('$lib/utils/chat/salonUnsent');
    const messaging = useMessaging();
    const ctx = makeContext();

    const done = messaging.handleSendChat(ctx, 'ledgered');
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled());
    // A reload now would find it: peek without consuming by treating it as an orphan, then put it back.
    const orphans = await takeOrphanedSalonTexts('me', CHANNEL, new Set());
    expect(orphans.map((o) => o.text)).toEqual(['ledgered']);
    const { recordUnsentSalonText } = await import('$lib/utils/chat/salonUnsent');
    recordUnsentSalonText('me', orphans[0]);

    answer({ id: 'srv' });
    await done;
    expect(await takeOrphanedSalonTexts('me', CHANNEL, new Set())).toEqual([]);
  });

  it('a failed row can be discarded', async () => {
    sendMock.mockRejectedValueOnce(new ApiRefusalError(403, null, 'boom'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'hello');

    messaging.discardSend(ctx, rows(ctx)[0].id);

    expect(rows(ctx)).toHaveLength(0);
  });

  it('a gateway 5xx after the save is an UNKNOWN outcome too, not a refusal', async () => {
    // A 502/504 may come from a proxy after the social service stored the row.
    for (const status of [500, 502, 504]) {
      sendMock.mockRejectedValueOnce(new ApiRefusalError(status, null, 'gateway'));
      const { useMessaging } = await import('./useMessaging.svelte');
      const ctx = makeContext();
      await useMessaging().handleSendChat(ctx, `five-oh-${status}`);
      expect(rows(ctx)[0]).toMatchObject({ status: 'unconfirmed', awaitingServerId: true });
    }
  });

  it('an unconfirmed row is put back in the composer: its text returned, its row and ledger gone', async () => {
    sendMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const { takeOrphanedSalonTexts } = await import('$lib/utils/chat/salonUnsent');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'take me back');

    expect(messaging.takeBackSend(ctx, rows(ctx)[0].id)).toBe('take me back');

    expect(rows(ctx)).toHaveLength(0);
    expect(await takeOrphanedSalonTexts('me', CHANNEL, new Set())).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a double-click on Retry sends once', async () => {
    sendMock.mockRejectedValueOnce(new ApiRefusalError(422, null, 'refused'));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'retry me');
    const localId = rows(ctx)[0].id;

    let answer: (row: { id: string }) => void = () => {};
    sendMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const first = messaging.retrySend(ctx, localId);
    const second = messaging.retrySend(ctx, localId);
    answer({ id: 'srv-once' });
    await Promise.all([first, second]);

    expect(sendMock).toHaveBeenCalledTimes(2); // the original send and ONE retry
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'srv-once', status: 'sent' });
  });
});
