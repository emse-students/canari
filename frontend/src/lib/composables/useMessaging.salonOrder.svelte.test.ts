// @vitest-environment happy-dom
/**
 * A SALON IS RECEIVED IN THE ORDER IT WAS WRITTEN, WHATEVER AN OUTAGE DID (2026-11-22).
 *
 * Read on the iPhone 12 (`1.7.3-alpha.5`): dev's social-service stopped about 80 s while `T1`..`T8`
 * were written in one salon, and the server stored `T1 T6 T7 T8 T2 T3 T4 T5` - each held text owned
 * its own ladder step, so the texts written after the return, and the one whose step ended first,
 * went before the older ones still waiting. Each arrived once and none failed: only the ORDER was
 * wrong. The fix is one lane per salon (`salonSendLane.ts`): no later text is POSTed while an earlier
 * one still waits to go by itself. These tests drive a fake server that is down, then up, and read
 * the order it STORED - never a wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { connectivity } from '$lib/stores/connectivity.svelte';
import { openSalonSendGate, resetSalonSendGate } from '$lib/utils/graine/salonSendGate';
import { decodeAppMessage } from '$lib/proto/codec';
import { ChannelApiError } from '$lib/services/ChannelService';
import { clearAllUploads, textWaitOf } from '$lib/utils/chat/uploadProgress.svelte';
import {
  forgetSalonSendsOfEndedSession,
  runInSalonTurn,
  SalonLaneHeldError,
  SalonTurnAbandonedError,
} from '$lib/utils/chat/messaging';
import { MAX_UNAVAILABLE_ANSWERS } from '$lib/utils/chat/retryLadder';
import { resetOwedSalonWrites } from '$lib/utils/chat/salonOwed';

const CHANNEL = 'channel_7a1d0c2e-0000-4000-8000-000000000002';
const LEDGER_KEY = 'canari.salon-unsent.me';

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
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setAuthToken: vi.fn(),
    setSendError: vi.fn(),
    playSendTone: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

const rows = (ctx: MessagingContext) => ctx.conversations.get(CHANNEL)!.messages;

/**
 * The social-service behind its proxy: while down, every POST is answered 502 (the proxy); while
 * up, the row is stored ONCE per client id (migration 090) and the stored order is what a reader of
 * the salon sees. The text is read back from the sealed payload, so the order is the texts'.
 */
function fakeServer() {
  const server = { up: true, stored: [] as string[], byClientId: new Map<string, string>() };
  sendMock.mockImplementation(async (_channel: string, payload: Uint8Array, clientId: string) => {
    if (!server.up) {
      throw new ChannelApiError(502, null, '{"statusCode":502,"message":"upstream unavailable"}');
    }
    let id = server.byClientId.get(clientId);
    if (!id) {
      const decoded = decodeAppMessage(payload);
      id = `srv-${server.stored.length + 1}`;
      server.byClientId.set(clientId, id);
      server.stored.push(decoded?.text?.content ?? decoded?.reply?.content ?? '?');
    }
    return { id, clientMessageId: clientId };
  });
  return server;
}

/** Every POST the device made, as the text it carried - what the server was ASKED, in order. */
const asked = () =>
  sendMock.mock.calls.map((c) => {
    const decoded = decodeAppMessage(c[1] as Uint8Array);
    return decoded?.text?.content ?? decoded?.reply?.content ?? '?';
  });

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockReset();
  localStorage.clear();
  connectivity.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetSalonSendGate();
  openSalonSendGate(CHANNEL);
  clearAllUploads();
  forgetSalonSendsOfEndedSession();
  // `connectivity.reset()` drops every reconnect listener, the owed writes' included.
  resetOwedSalonWrites();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  connectivity.reset();
  vi.restoreAllMocks();
});

describe('the outage drill of 2026-11-22: T1..T8 across a stopped social-service', () => {
  it('T1 before, T2..T6 during, T7 and T8 after the return: stored T1..T8, each once', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.handleSendChat(ctx, 'T1');
    server.up = false;
    // Written every few seconds through the outage; each one's ladder would have run on its own.
    for (const text of ['T2', 'T3', 'T4', 'T5', 'T6']) {
      await messaging.handleSendChat(ctx, text);
      await vi.advanceTimersByTimeAsync(9_000);
    }
    // Nothing written after T2 was ever POSTed while T2 waited: only T2 asked the server.
    expect(new Set(asked().slice(1))).toEqual(new Set(['T2']));
    expect(rows(ctx).filter((r) => r.status === 'pending')).toHaveLength(5);

    server.up = true;
    await messaging.handleSendChat(ctx, 'T7');
    await messaging.handleSendChat(ctx, 'T8');
    await vi.waitFor(() => expect(server.stored).toHaveLength(8));

    expect(server.stored).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
    expect(rows(ctx).map((r) => r.status)).toEqual(Array(8).fill('sent'));
    expect(JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]')).toEqual([]);
    // No failure was drawn on the way, as before the fix.
    expect(ctx.setSendError).not.toHaveBeenCalledWith(expect.stringMatching(/./));
  });

  it('with nothing written after the return, the head`s ladder step drains the salon in order', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    for (const text of ['A', 'B', 'C']) await messaging.handleSendChat(ctx, text);
    server.up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(server.stored).toHaveLength(3));

    expect(server.stored).toEqual(['A', 'B', 'C']);
    // B and C were never on the wire before A was stored.
    expect(asked().indexOf('B')).toBeGreaterThan(asked().lastIndexOf('A'));
    expect(asked().filter((t) => t === 'B')).toHaveLength(1);
    expect(asked().filter((t) => t === 'C')).toHaveLength(1);
  });

  it('a reconnect drains the salon in order too, the later texts waiting for the earlier', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    for (const text of ['A', 'B', 'C']) await messaging.handleSendChat(ctx, text);
    server.up = true;
    connectivity.notifyServerUnreachable('test');
    connectivity.notifyServerReachable();
    // Well before A's first ladder step (2 s): the reconnect is what drained it.
    await vi.advanceTimersByTimeAsync(500);
    expect(server.stored).toEqual(['A', 'B', 'C']);
  });
});

describe('the lane holds only what the machine will send by itself', () => {
  it('a text whose POST is in flight holds the next one until it is answered', async () => {
    let answerFirst: (row: { id: string }) => void = () => {};
    sendMock
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ id: 'srv-second' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    // Not awaited: the first send's answer is what this test holds back.
    void messaging.handleSendChat(ctx, 'first');
    await messaging.handleSendChat(ctx, 'second');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMock).toHaveBeenCalledTimes(1);

    answerFirst({ id: 'srv-first' });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(asked()).toEqual(['first', 'second']);
  });

  it('a REFUSED head leaves the lane: the text written after it goes at once', async () => {
    sendMock
      .mockRejectedValueOnce(new ChannelApiError(403, null, 'forbidden'))
      .mockResolvedValueOnce({ id: 'srv-after' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.handleSendChat(ctx, 'refused');
    expect(rows(ctx)[0].status).toBe('error');
    await messaging.handleSendChat(ctx, 'next');
    // Rows are ordered for display (the server's time), so the sent one is found by its id.
    await vi.waitFor(() =>
      expect(rows(ctx).find((r) => r.id === 'srv-after')).toMatchObject({ status: 'sent' })
    );
    expect(
      rows(ctx)
        .map((r) => r.status)
        .sort()
    ).toEqual(['error', 'sent']);
  });

  it('a held head given up by its author lets the next one go, which was waiting behind it', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    await messaging.handleSendChat(ctx, 'given up');
    await messaging.handleSendChat(ctx, 'kept');
    // The ledger keeps the order they were written in (the rows are ordered for display).
    const givenUp = (
      JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as { messageId: string }[]
    )[0].messageId;
    server.up = true;

    messaging.discardSend(ctx, givenUp);
    await vi.waitFor(() => expect(server.stored).toEqual(['kept']));
    expect(asked().filter((t) => t === 'kept')).toHaveLength(1);
  });
});

describe('what a past page life left goes in the order it was written', () => {
  it('the ledger`s entries are POSTed one after the other, in the ledger`s order', async () => {
    const entries = ['P1', 'P2', 'P3'].map((text, i) => ({
      messageId: `0b5d6c1e-2f3a-4b4c-9d5e-6f7a8b9c0d1${i}`,
      conversationKey: CHANNEL,
      text,
      sentAt: 1_000 + i,
    }));
    localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    await useMessaging().resumeUnsentSends(ctx, null);
    await vi.waitFor(() => expect(server.stored).toHaveLength(3));
    expect(server.stored).toEqual(['P1', 'P2', 'P3']);
    expect(asked()).toEqual(['P1', 'P2', 'P3']);
  });
});

/**
 * Review of #3964: probes the lane against the cases its first version got wrong. The page life is
 * a fresh one in every test - no answer has been seen before the outage starts.
 */
describe('the review probes of #3964', () => {
  it('B1: twelve texts typed fast behind a held head do not spend its bound: H X1..X12 Z', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    await messaging.handleSendChat(ctx, 'H');
    const xs = Array.from({ length: MAX_UNAVAILABLE_ANSWERS }, (_, i) => `X${i + 1}`);
    for (const text of xs) {
      await messaging.handleSendChat(ctx, text);
      await vi.advanceTimersByTimeAsync(500);
    }
    // Every text typed asked H again, and none of those answers was counted: H is still held.
    expect(asked().filter((t) => t === 'H').length).toBeGreaterThan(MAX_UNAVAILABLE_ANSWERS);
    expect(rows(ctx).some((r) => r.status === 'unconfirmed')).toBe(false);

    server.up = true;
    await messaging.handleSendChat(ctx, 'Z');
    await vi.waitFor(() => expect(server.stored).toHaveLength(MAX_UNAVAILABLE_ANSWERS + 2));
    expect(server.stored).toEqual(['H', ...xs, 'Z']);
  });

  it('A: an outage before the first send of the page life: A B C, then D after the return', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    for (const text of ['A', 'B', 'C']) await messaging.handleSendChat(ctx, text);
    // Held for the server, never handed to the author: no answer had to prove anything first.
    expect(rows(ctx).map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
    server.up = true;
    await messaging.handleSendChat(ctx, 'D');
    await vi.waitFor(() => expect(server.stored).toHaveLength(4));
    expect(server.stored).toEqual(['A', 'B', 'C', 'D']);
  });

  it('C: a reload during the outage: the ledger P1 P2 P3, then NEW typed, then the return', async () => {
    const entries = ['P1', 'P2', 'P3'].map((text, i) => ({
      messageId: `1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5${i}`,
      conversationKey: CHANNEL,
      text,
      sentAt: 2_000 + i,
    }));
    localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
    const server = fakeServer();
    server.up = false;
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.resumeUnsentSends(ctx, null);
    await vi.waitFor(() => expect(asked()).toContain('P1'));
    await messaging.handleSendChat(ctx, 'NEW');
    // Nothing behind P1 was ever on the wire during the outage.
    expect(new Set(asked())).toEqual(new Set(['P1']));

    server.up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(server.stored).toHaveLength(4));
    expect(server.stored).toEqual(['P1', 'P2', 'P3', 'NEW']);
  });

  it('a text waiting behind another says so: "waiting for the previous message"', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    await messaging.handleSendChat(ctx, 'first');
    await messaging.handleSendChat(ctx, 'second');
    const [first, second] = (
      JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as { messageId: string }[]
    ).map((e) => e.messageId);
    expect(textWaitOf(first)).toBe('server');
    expect(textWaitOf(second)).toBe('turn');

    server.up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(server.stored).toEqual(['first', 'second']));
    expect(textWaitOf(second)).toBeUndefined();
  });

  it('S3: a poll behind a HELD text is refused, never queued unseen - and holds nothing up', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    server.up = false;
    await messaging.handleSendChat(ctx, 'held');
    const poll = vi.fn(async () => {
      server.stored.push('POLL');
    });
    await expect(runInSalonTurn(CHANNEL, 'poll', poll)).rejects.toBeInstanceOf(SalonLaneHeldError);
    expect(poll).not.toHaveBeenCalled();

    server.up = true;
    await messaging.handleSendChat(ctx, 'after');
    await vi.waitFor(() => expect(server.stored).toEqual(['held', 'after']));
  });

  it('S3: a poll behind a text IN FLIGHT waits for its answer, then goes after it', async () => {
    let answer: (row: { id: string; clientMessageId: string }) => void = () => {};
    sendMock.mockImplementationOnce(
      (_c: string, _p: Uint8Array, clientId: string) =>
        new Promise((resolve) => (answer = (row) => resolve({ ...row, clientMessageId: clientId })))
    );
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();
    void useMessaging().handleSendChat(ctx, 'in flight');
    const order: string[] = [];
    const posted = runInSalonTurn(CHANNEL, 'poll', async () => {
      order.push('POLL');
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual([]);

    order.push('TEXT');
    answer({ id: 'srv-text', clientMessageId: '' });
    await posted;
    expect(order).toEqual(['TEXT', 'POLL']);
  });

  it('S3: a poll waiting behind a text that then gets HELD is refused at that moment', async () => {
    let fail: (e: unknown) => void = () => {};
    sendMock.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();
    void useMessaging().handleSendChat(ctx, 'about to be held');
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const poll = vi.fn(async () => {});
    const posted = runInSalonTurn(CHANNEL, 'poll', poll);
    const refused = expect(posted).rejects.toBeInstanceOf(SalonLaneHeldError);

    fail(new ChannelApiError(503, null, 'upstream unavailable'));
    await refused;
    expect(poll).not.toHaveBeenCalled();
  });

  it('B2: the session ending while a post waits rejects it as abandoned, and posts nothing', async () => {
    sendMock.mockImplementationOnce(() => new Promise(() => {}));
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();
    void useMessaging().handleSendChat(ctx, 'never answered');
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const poll = vi.fn(async () => {});
    const posted = runInSalonTurn(CHANNEL, 'poll', poll);
    const abandoned = expect(posted).rejects.toBeInstanceOf(SalonTurnAbandonedError);

    forgetSalonSendsOfEndedSession();
    await abandoned;
    expect(poll).not.toHaveBeenCalled();
  });

  it('S3: a poll whose post is refused leaves the lane: the next text is not held by it', async () => {
    const server = fakeServer();
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await expect(
      runInSalonTurn(CHANNEL, 'poll', () => Promise.reject(new Error('refused')))
    ).rejects.toThrow('refused');
    await messaging.handleSendChat(ctx, 'after the poll');
    expect(server.stored).toEqual(['after the poll']);
  });
});
