// @vitest-environment happy-dom
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
import {
  beginSalonListing,
  forgetSalonSendGates,
  openSalonSendGate,
  resetSalonSendGate,
  salonSendWaiterCount,
  settleSalonListing,
} from '$lib/utils/graine/salonSendGate';
import { m } from '$lib/paraglide/messages';

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
    // The salon is LOADED for every test below unless one says otherwise (`salonSendGate`).
    resetSalonSendGate();
    openSalonSendGate(CHANNEL);
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

/**
 * A SALON NOT YET LOADED HOLDS THE SEND (user report 2026-10-13: "ce salon n'est pas encore charge",
 * sent right after opening the app, and the message was lost to a restart). The row stays `pending`,
 * NOTHING reaches the seal while held, and the event that ends the wait decides the outcome.
 */
describe('a salon text sent before its salon is loaded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockReset();
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh session: no listing has settled, and this salon is not entered yet.
    resetSalonSendGate();
  });

  it('is HELD as a pending row and sent once the salon is entered', async () => {
    sendMock.mockResolvedValue({ id: 'server-held-1', serverMs: 2_000 });
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const token = beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'typed too early');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));

    // Held: on screen as pending, nothing sealed, no banner, the text owed to a reload.
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ status: 'pending', awaitingServerId: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(ctx.setSendError).not.toHaveBeenCalledWith(expect.stringMatching(/./));
    const { takeOrphanedSalonTexts } = await import('$lib/utils/chat/salonUnsent');
    expect(await takeOrphanedSalonTexts('me', CHANNEL, new Set())).toEqual([
      expect.objectContaining({ text: 'typed too early' }),
    ]);

    // The listing enters the salon: the held send goes, sealed THEN, under its own client id.
    openSalonSendGate(CHANNEL);
    expect(await done).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe(CHANNEL.replace(/^channel_/, ''));
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'server-held-1', status: 'sent' });

    // The listing settling afterwards releases nothing a second time.
    settleSalonListing(token, 'loaded');
    await Promise.resolve();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('holds two sends and sends each of them exactly once', async () => {
    let n = 0;
    sendMock.mockImplementation(async () => ({ id: `srv-${++n}` }));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    beginSalonListing();

    const first = messaging.handleSendChat(ctx, 'one');
    const second = messaging.handleSendChat(ctx, 'two');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(2));
    expect(sendMock).not.toHaveBeenCalled();

    openSalonSendGate(CHANNEL);
    await Promise.all([first, second]);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const sentIds = sendMock.mock.calls.map((c) => c[2]);
    expect(new Set(sentIds).size).toBe(2);
    expect(rows(ctx).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('turns failed - with its Retry - when the listing settles without the salon', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const token = beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'never listed');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    settleSalonListing(token, 'loaded');

    expect(await done).toBe(true); // echoed: the text lives in the failed row
    expect(sendMock).not.toHaveBeenCalled();
    expect(rows(ctx)[0]).toMatchObject({ status: 'error', awaitingServerId: true });
    expect(ctx.setSendError).toHaveBeenLastCalledWith(m.chat_send_error_salon_not_listed());

    // A later listing enters it after all: the row's Retry sends the SAME message, once.
    sendMock.mockResolvedValueOnce({ id: 'srv-late' });
    openSalonSendGate(CHANNEL);
    const localId = rows(ctx)[0].id;
    await messaging.retrySend(ctx, localId);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toBe(localId);
    expect(rows(ctx)[0]).toMatchObject({ id: 'srv-late', status: 'sent' });
  });

  it('names a listing that GAVE UP, not a salon that is gone', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const token = beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'offline');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    settleSalonListing(token, 'failed');

    await done;
    expect(rows(ctx)[0]).toMatchObject({ status: 'error' });
    expect(ctx.setSendError).toHaveBeenLastCalledWith(m.chat_send_error_salon_listing_failed());
  });

  it('is refused as LEFT when its community leaves the device while held', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'too late');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    forgetSalonSendGates([CHANNEL]);

    await done;
    expect(sendMock).not.toHaveBeenCalled();
    expect(rows(ctx)[0]).toMatchObject({ status: 'error' });
    expect(ctx.setSendError).toHaveBeenLastCalledWith(m.chat_send_error_salon_left());
  });

  it('is refused on sign-out, and the banner stays off a conversation it was not sent from', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'signing out');
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    (ctx as { selectedContact: string | null }).selectedContact = 'channel_somewhere-else';
    resetSalonSendGate();

    await done;
    expect(sendMock).not.toHaveBeenCalled();
    expect(rows(ctx)[0]).toMatchObject({ status: 'error' });
    expect(ctx.setSendError).not.toHaveBeenCalledWith(m.chat_send_error_salon_session_ended());
  });

  it('is refused at once, never held, when a listing has already settled without the salon', async () => {
    settleSalonListing(beginSalonListing(), 'loaded');
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.handleSendChat(ctx, 'not mine');
    expect(salonSendWaiterCount(CHANNEL)).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(rows(ctx)[0]).toMatchObject({ status: 'error' });
  });
});
