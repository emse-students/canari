/**
 * A DM/GROUP FILE IS QUEUED AT THE TAP, LIKE A TEXT (backlog item 27, 2026-11-01).
 *
 * `handleSendChat` used to wait for the inbound queue and a membership round trip BEFORE it wrote
 * anything - 18 s on a stalled link with no bubble on screen. The outbox flush already asks both
 * questions before every send, so the file is now read, its placeholder and its outbox entry written
 * together, with no MLS or membership question in between. These cases pin the send side: no
 * barrier, the entry durable at the tap, the order against texts, and what a refused write gives
 * back. What the outbox does with the entry afterwards - the held group, the upload, its failure
 * and its retry, the resume after a kill - is `outbox.test.ts` ("a file queued at the tap").
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

// The sign-out counter, moved by hand: a sign-out begins by bumping it (`clearAuthCounted`).
const signOut = vi.hoisted(() => ({ count: 0 }));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  signOutGeneration: () => signOut.count,
}));

const enqueueMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return { ...actual, enqueueOutboxMessage: (...args: unknown[]) => enqueueMock(...args) };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { PendingMediaFile } from '$lib/media';
import type { OutboxEntry, StoredMessage } from '$lib/db';
import { parseEnvelope } from '$lib/envelope';
import { OutboxEnqueueError } from '$lib/utils/chat/outbox';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../test/flush';

const CONVO = 'conversation-key';

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
        lifecycle: 'active',
      } as never,
    ],
  ]);
  return {
    conversations,
    userId: 'me',
    selectedContact: CONVO,
    // Live, like the page's: a test that moves the selection moves what is on screen.
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setSendError: vi.fn(),
    log: vi.fn(),
    // NOT ASKED ON THE SEND PATH ANY MORE: a send that reaches it throws, and the case fails.
    ensureMls: vi.fn(() => {
      throw new Error('the send path asked the MLS service');
    }),
  } as unknown as MessagingContext;
}

/** A context whose storage records the pair write of a placeholder and its entry. */
function withStorage(ctx: MessagingContext, pair: (row: StoredMessage, e: OutboxEntry) => void) {
  Object.assign(ctx, {
    deviceKeyB64: 'device-key',
    saveConversation: vi.fn().mockResolvedValue(undefined),
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessageWithOutboxEntry: vi.fn(async (row: StoredMessage, e: OutboxEntry) => pair(row, e)),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    },
  });
  return ctx;
}

const entryOf = (arrayBuffer: () => Promise<ArrayBuffer>): PendingMediaFile =>
  ({
    file: { name: 'a.pdf', type: 'application/pdf', size: 3, arrayBuffer },
    width: undefined,
    height: undefined,
  }) as unknown as PendingMediaFile;

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

/** The media enqueues held open until the test settles them; a text enqueue resolves at once. */
function holdMediaEnqueues() {
  const held: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  enqueueMock.mockImplementation((entry?: OutboxEntry) =>
    entry?.kind === 'media'
      ? new Promise<void>((resolve, reject) => held.push({ resolve, reject }))
      : Promise.resolve()
  );
  return held;
}

const queued = () => enqueueMock.mock.calls.map(([e]) => e as OutboxEntry);
const logLines = (ctx: MessagingContext) => vi.mocked(ctx.log).mock.calls.map(([l]) => String(l));

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
  // The upload ceiling: asked once when a file is staged, answered generously.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ maxBytes: 50 * 1024 * 1024 }),
        }) as Response
    )
  );
});
afterEach(() => vi.restoreAllMocks());

describe('a file is queued at the tap - no barrier before it', () => {
  it('writes the bubble and the entry without asking the MLS service or the membership', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, '', { files: [entryOf(async () => new ArrayBuffer(3))] });

    expect(ctx.ensureMls).not.toHaveBeenCalled();
    expect(queued().map((e) => e.kind)).toEqual(['media']);
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    expect(ctx.conversations.get(CONVO)!.messages[0].status).toBe('pending');
    expect(logLines(ctx).some((l) => l.includes('barrier'))).toBe(false);
  });

  it('the bubble is on screen before the queue has answered', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    const sending = messaging.handleSendChat(ctx, '', {
      files: [entryOf(async () => new ArrayBuffer(3))],
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));

    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    held[0].resolve();
    await sending;
  });

  it('a row awaiting re-admission takes the file: the outbox holds it, nothing is refused', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    ctx.conversations.set(CONVO, { ...ctx.conversations.get(CONVO)!, lifecycle: 'pending' });
    await messaging.handleSendChat(ctx, '', { files: [entryOf(async () => new ArrayBuffer(3))] });

    expect(queued().map((e) => e.kind)).toEqual(['media']);
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    expect(vi.mocked(ctx.setSendError).mock.calls.every(([v]) => v === '')).toBe(true);
  });

  it('TAP THEN KILL: the entry is durable beside its placeholder before any upload, bytes and all', async () => {
    const messaging = await freshMessaging();
    const pairs: { row: StoredMessage; entry: OutboxEntry }[] = [];
    const ctx = withStorage(makeContext(), (row, entry) => pairs.push({ row, entry }));
    // The kill: the live queue never answers. What the next launch finds is what was written.
    enqueueMock.mockImplementation(() => new Promise(() => {}));
    void messaging.handleSendChat(ctx, '', {
      files: [entryOf(async () => new Uint8Array([7, 8, 9]).buffer)],
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledOnce());

    expect(pairs).toHaveLength(1);
    const { row, entry } = pairs[0];
    expect(row.id).toBe(entry.id);
    expect(entry.kind).toBe('media');
    expect([...entry.media!.fileBytes!]).toEqual([7, 8, 9]);
    // NO KEY YET: the CEK is generated by the upload (`encryptAndUpload`), on the outbox side.
    expect(entry.media!.uploadedRef).toBeUndefined();
    const placeholder = parseEnvelope(row.content);
    expect(placeholder.kind === 'media' && placeholder.media.mediaId).toBe('');
    // Told it is already on disk, so the queue does not write it twice.
    expect(enqueueMock.mock.calls[0][1]).toEqual({ alreadyDurable: true });
  });

  it('a pair write that failed lets the outbox write its own row, and the bubble stays', async () => {
    const messaging = await freshMessaging();
    const ctx = withStorage(makeContext(), () => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await messaging.handleSendChat(ctx, '', { files: [entryOf(async () => new ArrayBuffer(3))] });

    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(enqueueMock.mock.calls[0][1]).toBeUndefined();
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    expect(logLines(ctx).some((l) => l.includes('NOT written together'))).toBe(true);
  });

  it("a row written beside its placeholder is the queue's even when the live queue refuses it", async () => {
    const messaging = await freshMessaging();
    const ctx = withStorage(makeContext(), () => {});
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);
    const accused = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The class of the module graph `freshMessaging` just loaded: `instanceof` is the classification.
    const { MessageWrittenError } = await import('$lib/utils/chat/messageWrittenError');
    enqueueMock.mockImplementation(async (e: OutboxEntry) => {
      throw new MessageWrittenError(e.id, new OutboxEnqueueError('no active outbox controller'));
    });
    await messaging.handleSendChat(ctx, '');

    // Neither withdrawn nor re-staged: a second Send would post it twice.
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([]);
    expect(ctx.setSendError).not.toHaveBeenCalledWith(m.chat_media_send_error_generic());
    expect(accused).toHaveBeenCalled();
  });

  it('a deleted conversation refuses the file, gives it back and says why', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    ctx.conversations.set(CONVO, { ...ctx.conversations.get(CONVO)!, lifecycle: 'removed' });
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);

    // FALSE: the composer gives back the caption it cleared at the tap (MainChatPage).
    expect(await messaging.handleSendChat(ctx, 'the caption')).toBe(false);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(0);
    expect(messaging.pendingMediaFilesFor(CONVO).map((e) => e.file.name)).toEqual(['a.pdf']);
    expect(ctx.setSendError).toHaveBeenCalledWith(m.chat_conversation_deleted_message());
  });

  it('a voice note into a deleted conversation is not re-staged, and the log says so', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    ctx.conversations.set(CONVO, { ...ctx.conversations.get(CONVO)!, lifecycle: 'removed' });

    expect(
      await messaging.handleSendChat(ctx, '', { files: [entryOf(async () => new ArrayBuffer(3))] })
    ).toBe(false);

    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([]);
    expect(ctx.setSendError).toHaveBeenCalledWith(m.chat_conversation_deleted_message());
    expect(logLines(ctx).some((l) => l.includes('NOT re-staged (a voice note'))).toBe(true);
  });
});

describe('a file keeps its place among the texts sent around it', () => {
  // A clock that only moves forward, a second per reading: the order is the taps', never a race of
  // two readings inside one millisecond.
  beforeEach(() => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
  });

  it('a text before the file and a text after it are dated around it, in tap order', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, 'before');
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);
    await messaging.handleSendChat(ctx, '');
    await messaging.handleSendChat(ctx, 'after');

    const order = [...queued()].sort((a, b) => a.sentAt - b.sentAt);
    expect(order.map((e) => e.text ?? e.kind)).toEqual(['before', 'media', 'after']);
  });

  it('a text typed while the file is still being written is dated after EVERY file of the tap', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('one.pdf'), pdf('two.pdf')], ctx);

    const sending = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // The first file's write is still running; the member sends a text.
    await messaging.handleSendChat(ctx, 'typed meanwhile');
    held[0].resolve();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1].resolve();
    await sending;

    const order = [...queued()].sort((a, b) => a.sentAt - b.sentAt);
    expect(order.map((e) => e.text ?? e.media?.fileName)).toEqual([
      'one.pdf',
      'two.pdf',
      'typed meanwhile',
    ]);
  });
});

describe('an attachment the queue cannot take', () => {
  it('a file that cannot be read writes no placeholder and is re-staged', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const file = entryOf(async () => {
      throw new DOMException('gone', 'NotReadableError');
    });
    await messaging.handleSendChat(ctx, '', { files: [file] });
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([file]);
  });

  it('a refused enqueue withdraws the placeholder, re-stages the file and says so', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    enqueueMock.mockImplementation(async (entry?: { kind: string }) => {
      if (entry?.kind !== 'media') return;
      throw new OutboxEnqueueError('the durable write failed');
    });
    const file = entryOf(async () => new ArrayBuffer(3));
    await messaging.handleSendChat(ctx, '', { files: [file] });
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(0);
    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([file]);
    expect(ctx.setSendError).toHaveBeenCalledWith(m.chat_media_send_error_generic());
    expect(logLines(ctx).some((l) => l.includes('not queued, withdrawing its placeholder'))).toBe(
      true
    );
  });

  it('a queued attachment keeps its placeholder', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, '', {
      files: [entryOf(async () => new ArrayBuffer(3))],
    });
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
  });
});

describe('the staging belongs to ONE conversation and ONE account', () => {
  it('a sign-out DURING the preparation stages nothing (a shared file never reaches the next account)', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    let signedIn = true;
    // The preparation is where the seconds go; the member signs out inside it.
    const stillWanted = vi.fn(() => signedIn);
    const staging = messaging.handleFilesSelected([pdf('a.pdf')], ctx, { stillWanted });
    signedIn = false;
    await staging;
    expect(stillWanted).toHaveBeenCalled();
    expect(messaging.pendingMediaFilesFor(CONVO)).toHaveLength(0);
  });

  it('a photo staged in A, Send in B posts nothing of A', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);
    expect(messaging.pendingMediaFilesFor(CONVO)).toHaveLength(1);

    (ctx as { selectedContact: string | null }).selectedContact = 'conversation-b';
    await messaging.handleSendChat(ctx, 'hello B');

    const sendLine = logLines(ctx).find((l) => l.startsWith('[SEND] handleSendChat'));
    expect(sendLine).toMatch(/files=0$/);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFilesFor(CONVO)).toHaveLength(1);
  });

  it('a file staged in the same conversation DURING a send stays for the next one', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('first.pdf')], ctx);

    const sending = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await messaging.handleFilesSelected([pdf('second.pdf')], ctx);
    held[0].resolve();
    await sending;

    expect(messaging.pendingMediaFilesFor(CONVO).map((e) => e.file.name)).toEqual(['second.pdf']);
  });

  // REPRO 2026-10-31: one staged video, Send tapped 13 times while the first tap was held for 18 s,
  // and 13 copies went out, each under a new message id.
  it('Send tapped again while the first send writes queues the staged file ONCE', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);

    const taps = [1, 2, 3].map(() => messaging.handleSendChat(ctx, ''));
    await flushMacrotask();
    expect(messaging.pendingMediaFilesFor(CONVO)).toHaveLength(0);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held[0].resolve();
    await Promise.all(taps);

    expect(queued().filter((e) => e.kind === 'media')).toHaveLength(1);
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
    expect(logLines(ctx).filter((l) => l === '[SEND] Abort: no text and no file')).toHaveLength(2);
  });

  it('a refused file goes back to ITS place: before a file staged during its write', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('first.pdf')], ctx);

    const sending = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await messaging.handleFilesSelected([pdf('second.pdf')], ctx);
    held[0].reject(new OutboxEnqueueError('the durable write failed'));
    await sending;

    expect(messaging.pendingMediaFilesFor(CONVO).map((e) => e.file.name)).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
  });

  it('two refused sends leave the staging in staging order', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('first.pdf')], ctx);
    const one = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await messaging.handleFilesSelected([pdf('second.pdf')], ctx);
    const two = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(2));

    // The first send's refusal lands first, so the second send's file returns to a staging that
    // already holds an OLDER file: prepending it would put second.pdf ahead of first.pdf.
    held[0].reject(new OutboxEnqueueError('the durable write failed'));
    await one;
    held[1].reject(new OutboxEnqueueError('the durable write failed'));
    await two;

    expect(messaging.pendingMediaFilesFor(CONVO).map((e) => e.file.name)).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
  });

  it('a refusal after the member moved on is said there as dropped', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);

    const sending = messaging.handleSendChat(ctx, '');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    (ctx as { selectedContact: string | null }).selectedContact = 'conversation-b';
    held[0].reject(new OutboxEnqueueError('the durable write failed'));
    await sending;

    expect(ctx.setSendError).toHaveBeenCalledWith(
      m.chat_media_dropped_other_conversation({ cause: m.chat_media_send_error_generic() })
    );
    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([]);
  });

  it('a sign-out during the write neither re-stages nor says anything', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const held = holdMediaEnqueues();
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);

    const sending = messaging.handleSendChat(ctx, 'caption');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    signOut.count++;
    messaging.forgetAccount(vi.fn());
    held[0].reject(new OutboxEnqueueError('the durable write failed'));
    await sending;

    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([]);
    expect(ctx.setSendError).not.toHaveBeenCalledWith(m.chat_media_send_error_generic());
    // The caption is not sealed for whoever signs in next either.
    expect(queued().some((e) => e.kind === 'text')).toBe(false);
    expect(logLines(ctx).some((l) => l.includes('signed out since the tap'))).toBe(true);
  });

  it('a sign-out forgets every staged file and armed reply', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleFilesSelected([pdf('a.pdf')], ctx);
    messaging.handleReply(CONVO, { id: 'm1' } as never);

    messaging.forgetAccount(vi.fn());

    expect(messaging.pendingMediaFilesFor(CONVO)).toEqual([]);
    expect(messaging.replyFor(CONVO)).toBeNull();
  });
});
