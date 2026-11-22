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
import {
  noteSalonSendAnswer,
  resetSalonRepeatProofForTests,
} from '$lib/utils/chat/salonRepeatProof';
import { ChannelApiError } from '$lib/services/ChannelService';
import { clearAllUploads } from '$lib/utils/chat/uploadProgress.svelte';
import { forgetSalonSendsOfEndedSession } from '$lib/utils/chat/messaging';
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
  resetSalonRepeatProofForTests();
  noteSalonSendAnswer('00000000-0000-4000-8000-0000000000ff', {
    clientMessageId: '00000000-0000-4000-8000-0000000000ff',
  });
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
    await vi.waitFor(() => expect(rows(ctx)[1]).toMatchObject({ id: 'srv-after', status: 'sent' }));
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
