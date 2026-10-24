// @vitest-environment happy-dom
/**
 * THE SALON QUEUE (WP-OFF-3): AN OFFLINE SEND IS HELD AND SENT ON THE RECONNECT, AND WHAT A KILLED
 * PAGE LIFE LEFT UNANSWERED IS SENT AGAIN - ALWAYS UNDER THE SAME CLIENT ID.
 *
 * Before it, a salon text sent offline was POSTed into a dead link, became `unconfirmed`, and waited
 * for its author; one left unanswered by a kill came back to the composer for its author to send by
 * hand. Both were deliberate while the server minted a new row for every POST, because an automatic
 * repeat of a message that HAD landed posted it twice. The server now answers a repeat of the client
 * id with the row it already holds (migration 090), so the queue may repeat - and every test here
 * asserts the repeat carries the FIRST attempt's client id, which is the whole of that safety.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';
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
import {
  beginSalonListing,
  openSalonSendGate,
  resetSalonSendGate,
} from '$lib/utils/graine/salonSendGate';
import { decodeAppMessage } from '$lib/proto/codec';
import {
  noteSalonSendAnswer,
  resetSalonRepeatProofForTests,
} from '$lib/utils/chat/salonRepeatProof';
import { ChannelApiError } from '$lib/services/ChannelService';
import { deliverOwedSalonWrites, isSalonWriteOwed } from '$lib/utils/chat/salonOwed';

/** An answer of a server carrying migration 090: it echoes the client id, so a repeat is safe. */
function proveRepeatsSafe() {
  noteSalonSendAnswer('00000000-0000-4000-8000-0000000000ff', {
    clientMessageId: '00000000-0000-4000-8000-0000000000ff',
  });
}

const CHANNEL = 'channel_7a1d0c2e-0000-4000-8000-000000000001';
const LEDGER_KEY = 'canari.salon-unsent.me';

function makeContext(withSalon = true) {
  const conversations = new SvelteMap<string, Conversation>(
    withSalon
      ? [
          [
            CHANNEL,
            { id: CHANNEL, name: CHANNEL, messages: [], unreadCount: 0, lastMessageAt: 0 } as never,
          ],
        ]
      : []
  );
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
const ledger = () =>
  JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as { messageId: string }[];

/** What the server would receive: the client id beside the payload, and the payload decoded. */
function posted(call: number) {
  const [, payload, messageId] = sendMock.mock.calls[call] as [string, Uint8Array, string];
  return { messageId, decoded: decodeAppMessage(payload) };
}

/** The link drops the way `trackedFetch` reports it: the store learns it BEFORE the throw reaches us. */
function dropTheLink() {
  connectivity.notifyServerUnreachable();
  return Promise.reject(new TransportFailureError(new TypeError('Failed to fetch')));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockReset();
  localStorage.clear();
  connectivity.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetSalonSendGate();
  openSalonSendGate(CHANNEL.replace(/^channel_/, ''));
  openSalonSendGate(CHANNEL);
  // Every test but the ones about the proof itself runs against a server known to carry 090.
  resetSalonRepeatProofForTests();
  proveRepeatsSafe();
});

afterEach(() => {
  connectivity.reset();
  vi.restoreAllMocks();
});

describe('a salon send while offline', () => {
  it('is HELD as pending, seals nothing, and goes on the reconnect under its client id', async () => {
    connectivity.notifyServerUnreachable();
    sendMock.mockResolvedValue({ id: 'srv-offline-1', serverMs: 5_000 });
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    expect(await useMessaging().handleSendChat(ctx, 'typed in the tunnel')).toBe(true);

    // Held: on screen, pending, nothing posted (a seal now would spend a key index for nothing),
    // no banner (the offline strip already says it), and the text durable in the ledger.
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ status: 'pending', awaitingServerId: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(ctx.setSendError).not.toHaveBeenCalledWith(expect.stringMatching(/./));
    const clientId = rows(ctx)[0].id;
    expect(ledger().map((e) => e.messageId)).toEqual([clientId]);

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-offline-1' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(posted(0).messageId).toBe(clientId);
    expect(rows(ctx)[0].status).toBe('sent');
    expect(ledger()).toEqual([]);
  });

  it('a POST that meets the link going down is owed to the reconnect, never left to its author', async () => {
    sendMock.mockImplementationOnce(dropTheLink);
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    expect(await useMessaging().handleSendChat(ctx, 'lost on the way')).toBe(true);
    const clientId = rows(ctx)[0].id;
    // Without the queue this row was `unconfirmed`, with a banner, and stayed so until a gesture.
    expect(rows(ctx)[0]).toMatchObject({ status: 'pending', awaitingServerId: true });
    expect(ctx.setSendError).not.toHaveBeenCalledWith(expect.stringMatching(/./));

    sendMock.mockResolvedValueOnce({ id: 'srv-after-cut' });
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-after-cut' }));
    // The SAME client id: if the first POST had landed, the server answers this one with its row.
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(posted(1).messageId).toBe(clientId);
    expect(posted(1).decoded?.messageId).toBe(clientId);
  });

  it('is owed again when the link drops a second time, and goes once on the next reconnect', async () => {
    sendMock.mockImplementationOnce(dropTheLink).mockImplementationOnce(dropTheLink);
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();
    await useMessaging().handleSendChat(ctx, 'twice cut');

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rows(ctx)[0].status).toBe('pending'));

    sendMock.mockResolvedValueOnce({ id: 'srv-third' });
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-third' }));
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(new Set(sendMock.mock.calls.map((c) => c[2])).size).toBe(1);
  });

  it('an unconfirmed send (link up) is retried by its author under the same client id', async () => {
    // No answer while the store still reads the link as up: nothing known will change the answer,
    // so it waits for the Retry, which is now safe.
    sendMock.mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'retry me');
    expect(rows(ctx)[0].status).toBe('unconfirmed');
    const clientId = rows(ctx)[0].id;

    sendMock.mockResolvedValueOnce({ id: 'srv-retried' });
    await messaging.retrySend(ctx, clientId);

    expect(posted(1).messageId).toBe(clientId);
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ id: 'srv-retried', status: 'sent' });
  });
});

describe('what a past page life left unanswered', () => {
  /** An entry a killed page life wrote: its owner lock is gone (no Web Locks here, no owner). */
  function leftByADeadLife(entry: Record<string, unknown>) {
    localStorage.setItem(LEDGER_KEY, JSON.stringify([entry]));
  }

  it('is sent again at the next start with its client id, clock and quote - not handed back', async () => {
    const clientId = '0b5d6c1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e';
    leftByADeadLife({
      messageId: clientId,
      conversationKey: CHANNEL,
      text: 'sent before the kill',
      sentAt: 1_234_000,
      replyTo: { id: 'srv-quoted', senderId: 'them', preview: 'the quote' },
    });
    sendMock.mockResolvedValue({ id: 'srv-resumed', serverMs: 9_000 });
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    const legacy = await useMessaging().resumeUnsentSends(ctx, null);

    expect(legacy).toEqual([]);
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-resumed' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const { messageId, decoded } = posted(0);
    expect(messageId).toBe(clientId);
    // The payload is the one composed: same inner id, same author clock, same quote.
    expect(decoded?.messageId).toBe(clientId);
    expect(Number(decoded?.sentAt)).toBe(1_234_000);
    expect(decoded?.reply?.content).toBe('sent before the kill');
    expect(decoded?.reply?.replyTo?.preview).toBe('the quote');
    expect(ledger()).toEqual([]);
  });

  it('an entry written before WP-OFF-3 (no sentAt) still goes back to the composer', async () => {
    leftByADeadLife({ messageId: 'legacy-1', conversationKey: CHANNEL, text: 'old shape' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    const legacy = await useMessaging().resumeUnsentSends(ctx, CHANNEL);

    expect(legacy.map((e) => e.text)).toEqual(['old shape']);
    expect(sendMock).not.toHaveBeenCalled();
    expect(rows(ctx)).toHaveLength(0);
  });

  it('waits for a salon with no conversation yet, kept for the moment it opens', async () => {
    leftByADeadLife({
      messageId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      conversationKey: CHANNEL,
      text: 'not drawn yet',
      sentAt: 42,
    });
    sendMock.mockResolvedValue({ id: 'srv-later' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const empty = makeContext(false);

    await messaging.resumeUnsentSends(empty, null);
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('kept for later'))
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger()).toHaveLength(1);

    // The salon opens: the entry is this page life's and nothing sends it, so it is taken now.
    const ctx = makeContext();
    await messaging.resumeUnsentSends(ctx, CHANNEL);
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-later' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('two resumes at the same instant draw and send it ONCE', async () => {
    leftByADeadLife({
      messageId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
      conversationKey: CHANNEL,
      text: 'exactly once',
      sentAt: 7,
    });
    let answer: (row: { id: string }) => void = () => {};
    sendMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await Promise.all([
      messaging.resumeUnsentSends(ctx, null),
      messaging.resumeUnsentSends(ctx, CHANNEL),
    ]);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    answer({ id: 'srv-once' });
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-once' }));
    expect(rows(ctx)).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('a repeat nobody asked for waits for the server to prove it safe', () => {
  // Store builds meet the server WITHOUT migration 090 for days (production deploys once both
  // stores serve the client), and that server posts a repeat twice. So no repeat goes unasked until
  // an answer has echoed a client id.
  beforeEach(() => resetSalonRepeatProofForTests());

  it('a POST lost as the link went down is unconfirmed, then goes once an answer proves it', async () => {
    sendMock.mockImplementationOnce(dropTheLink);
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    await useMessaging().handleSendChat(ctx, 'maybe landed');
    const clientId = rows(ctx)[0].id;
    expect(rows(ctx)[0].status).toBe('unconfirmed');

    // The reconnect alone sends nothing: the old server would post it a second time. Proven by
    // STATE rather than by waiting a while: the send is not owed to the reconnect, and the
    // reconnect's delivery (awaited here, so whatever it would send has been sent) finds nothing.
    expect(isSalonWriteOwed(`send:${clientId}`)).toBe(false);
    connectivity.notifyServerReachable();
    await deliverOwedSalonWrites();
    expect(sendMock).toHaveBeenCalledTimes(1);

    sendMock.mockResolvedValueOnce({ id: 'srv-proven' });
    proveRepeatsSafe();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-proven' }));
    expect(posted(1).messageId).toBe(clientId);
  });

  it('a send HELD offline before any POST still goes on the reconnect: nothing can have landed', async () => {
    connectivity.notifyServerUnreachable();
    sendMock.mockResolvedValue({ id: 'srv-held' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    await useMessaging().handleSendChat(ctx, 'never left');
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-held' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('what a past page life left is drawn unconfirmed, and sent once an answer proves it', async () => {
    const clientId = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';
    localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify([{ messageId: clientId, conversationKey: CHANNEL, text: 'killed', sentAt: 3 }])
    );
    sendMock.mockResolvedValue({ id: 'srv-after-proof' });
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    await useMessaging().resumeUnsentSends(ctx, null);
    await vi.waitFor(() => expect(rows(ctx)[0]?.status).toBe('unconfirmed'));
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger().map((e) => e.messageId)).toEqual([clientId]);

    proveRepeatsSafe();
    await vi.waitFor(() => expect(rows(ctx)[0]).toMatchObject({ id: 'srv-after-proof' }));
    expect(posted(0).messageId).toBe(clientId);
  });
});

describe('a resume whose session ends while it waits', () => {
  it('leaves the entry in its account ledger: the next account never seals it', async () => {
    const clientId = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c';
    localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify([
        { messageId: clientId, conversationKey: CHANNEL, text: 'A wrote it', sentAt: 4 },
      ])
    );
    resetSalonSendGate();
    beginSalonListing(); // The salon is not entered yet: the resume waits on its gate.
    const { useMessaging } = await import('./useMessaging.svelte');
    const ctx = makeContext();

    await useMessaging().resumeUnsentSends(ctx, null);
    resetSalonSendGate(); // Sign-out: the conversation map is still there, the session is not.

    await vi.waitFor(() =>
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('its session ended'))
    );
    expect(rows(ctx)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger().map((e) => e.messageId)).toEqual([clientId]);
  });
});

describe('a repeat of a message deleted since it landed', () => {
  it('is forgotten and its row removed, never offered again', async () => {
    sendMock.mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')));
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'removed by a moderator');
    const clientId = rows(ctx)[0].id;
    expect(rows(ctx)[0].status).toBe('unconfirmed');

    sendMock.mockRejectedValueOnce(
      new ChannelApiError(410, 'CHANNEL_MESSAGE_DELETED', 'this message was deleted')
    );
    await messaging.retrySend(ctx, clientId);

    expect(rows(ctx)).toHaveLength(0);
    expect(ledger()).toEqual([]);
  });
});
