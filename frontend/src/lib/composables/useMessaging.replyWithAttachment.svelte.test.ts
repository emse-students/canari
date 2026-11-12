/**
 * A REPLY SURVIVES ATTACHING A FILE (owner, 2026-11-10, 1.6.9).
 *
 * Replying to a message and then attaching a photo sent the photo as a plain message: `handleSendChat`
 * consumed the armed reply at the tap and only the TEXT path ever read it - the media path never
 * did, and the wire had no place for it (`MediaMsg` carried no reference). The reply now rides the
 * first file (like its caption): the outbox entry, the placeholder row, the proto and the envelope
 * built once the upload names the blob. These cases pin the send side (the reply is kept until the
 * send, then carried by the entry and the row, and given back when the file is refused) and the wire
 * (the proto round-trips the reference, a plain attachment encodes as before).
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

const enqueueMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return {
    ...actual,
    enqueueOutboxMessage: (...args: unknown[]) => enqueueMock(...args),
    applyOutboxPendingStatuses: async () => {},
  };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { PendingMediaFile } from '$lib/media';
import type { OutboxEntry } from '$lib/db';
import { parseEnvelope, serializeEnvelope, mkTextEnvelope } from '$lib/envelope';
import { buildMediaMessage } from '$lib/utils/chat/outbox';
import { appMsgToEnvelope } from '$lib/utils/chat/messageUtils';
import { decodeAppMessage } from '$lib/proto/codec';

const CONVO = 'conversation-key';

/** The message being answered: a text from another member. */
const quotedMessage = {
  id: 'quoted-1',
  senderId: 'bob',
  content: serializeEnvelope(mkTextEnvelope('see you at eight')),
} as never;

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
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setSendError: vi.fn(),
    log: vi.fn(),
    ensureMls: vi.fn(() => {
      throw new Error('the send path asked the MLS service');
    }),
  } as unknown as MessagingContext;
}

const photo = (name: string): PendingMediaFile =>
  ({
    file: {
      name,
      type: 'image/jpeg',
      size: 3,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    },
    width: 10,
    height: 10,
  }) as unknown as PendingMediaFile;

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

const queued = () => enqueueMock.mock.calls.map(([e]) => e as OutboxEntry);

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('a reply survives attaching a file', () => {
  it('the composer keeps the reply until the send, then the first file carries it - entry and row', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    messaging.handleReply(CONVO, quotedMessage);

    // ATTACHING does not touch the reply: it is still armed, and the composer still shows it.
    expect(messaging.replyFor(CONVO)?.id).toBe('quoted-1');

    await messaging.handleSendChat(ctx, 'a caption', { files: [photo('a.jpg'), photo('b.jpg')] });

    const entries = queued();
    expect(entries.map((e) => e.kind)).toEqual(['media', 'media']);
    // The first file (the caption's) answers the message; the second is a plain attachment.
    expect(entries[0].replyTo).toEqual({
      id: 'quoted-1',
      senderId: 'bob',
      preview: 'see you at eight',
    });
    expect(entries[0].media?.caption).toBe('a caption');
    expect(entries[1].replyTo).toBeUndefined();

    // The echo rows draw the same quote the text path draws.
    const rows = ctx.conversations.get(CONVO)!.messages;
    expect(rows).toHaveLength(2);
    const first = parseEnvelope(rows[0].content);
    expect(first.kind === 'media' && first.replyTo).toEqual({
      id: 'quoted-1',
      senderId: 'bob',
      content: 'see you at eight',
    });
    expect(rows[0].replyTo?.id).toBe('quoted-1');
    expect(rows[1].replyTo).toBeUndefined();

    // Sent: the reply is spent, the next message is a plain one.
    expect(messaging.replyFor(CONVO)).toBeNull();
  });

  it('a photo with no caption is a reply as well', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    messaging.handleReply(CONVO, quotedMessage);
    await messaging.handleSendChat(ctx, '', { files: [photo('a.jpg')] });
    expect(queued()[0].replyTo?.id).toBe('quoted-1');
    expect(queued()[0].media?.caption).toBeUndefined();
  });

  it('a plain attachment carries no reply', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    await messaging.handleSendChat(ctx, '', { files: [photo('a.jpg')] });
    expect(queued()[0].replyTo).toBeUndefined();
  });

  it('a first file the queue refused gives the reply back with it', async () => {
    const messaging = await freshMessaging();
    const ctx = makeContext();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueMock.mockRejectedValue(new Error('queue refused'));
    messaging.handleReply(CONVO, quotedMessage);
    await messaging.handleSendChat(ctx, '', { files: [photo('a.jpg')] });
    expect(messaging.replyFor(CONVO)?.id).toBe('quoted-1');
  });
});

describe('the wire carries the reply of a file', () => {
  const ref = { mediaId: 'blob-1', key: '00'.repeat(32), iv: '11'.repeat(12) };
  const media = { kind: 1, mimeType: 'image/jpeg', size: 3, caption: 'cap' };

  it('proto and envelope round-trip the reference', () => {
    const replyTo = { id: 'quoted-1', senderId: 'bob', preview: 'see you at eight' };
    const built = buildMediaMessage({ id: 'm1', sentAt: 1 }, media, ref, replyTo);
    const decoded = decodeAppMessage(built.proto)!;
    expect(decoded.media?.replyTo?.id).toBe('quoted-1');

    // The receiver's side: the same envelope the sender stored, quote included.
    const received = appMsgToEnvelope(decoded)!;
    const env = parseEnvelope(received.content);
    expect(env.kind === 'media' && env.replyTo).toEqual({
      id: 'quoted-1',
      senderId: 'bob',
      content: 'see you at eight',
    });
    expect(received.options.replyTo?.id).toBe('quoted-1');
    const sent = parseEnvelope(built.content);
    expect(sent.kind === 'media' && sent.replyTo).toEqual(env.kind === 'media' && env.replyTo);
  });

  it('an attachment that answers nothing decodes with no reply', () => {
    const built = buildMediaMessage({ id: 'm1', sentAt: 1 }, media, ref);
    const decoded = decodeAppMessage(built.proto)!;
    expect(decoded.media?.replyTo ?? null).toBeNull();
    const env = parseEnvelope(appMsgToEnvelope(decoded)!.content);
    expect(env.kind === 'media' && env.replyTo).toBeFalsy();
  });
});
