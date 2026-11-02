/**
 * A FILE SENT IN A SALON IS IN THE THREAD FROM THE TAP, WITH ITS UPLOAD ON ITS ROW (2026-11-02).
 *
 * The owner's report: a file sent in a conversation - a heavy one above all - disappeared for a long
 * time and came back, with nothing on screen in between. In a community salon the send uploaded the
 * whole file INLINE and drew no row at all: the message existed on screen only once the server's
 * frame came back. Here the upload is HELD by a promise the test settles - no clock - and the row
 * must be there, in its place, with the real transfer's progress, for the whole of it; a failure
 * keeps the row with its Retry, and a cancel aborts the transfer and takes the row away.
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

vi.mock('$lib/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/stores/auth')>();
  return { ...actual, getToken: async () => 'fresh-token' };
});

/** One held upload per call: its transport (progress, abort) and the hands that settle it. */
interface HeldUpload {
  transport: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number }) => void };
  resolve: (ref: import('$lib/media').MediaRef) => void;
  reject: (e: unknown) => void;
}
const uploads: HeldUpload[] = [];
vi.mock('$lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/media')>();
  class FakeMediaService extends actual.MediaService {
    encryptAndUpload(
      ..._args: Parameters<InstanceType<typeof actual.MediaService>['encryptAndUpload']>
    ): Promise<import('$lib/media').MediaRef> {
      const transport = (_args[4] ?? {}) as HeldUpload['transport'];
      return new Promise((resolve, reject) => uploads.push({ transport, resolve, reject }));
    }
  }
  return { ...actual, MediaService: FakeMediaService };
});

/** The POST of the sealed message, held the same way. */
const posts: Array<{ messageId: string; resolve: (row: unknown) => void }> = [];
vi.mock('$lib/utils/chat/channelCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/channelCrypto')>();
  return {
    ...actual,
    sendEncryptedChannelMessage: (_c: string, _p: Uint8Array, messageId: string) =>
      new Promise((resolve) => posts.push({ messageId, resolve })),
  };
});

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import { openSalonSendGate, resetSalonSendGate } from '$lib/utils/graine/salonSendGate';
import { retryUpload, uploadCancelOf, uploadViewOf } from '$lib/utils/chat/uploadProgress.svelte';
import { parseEnvelope } from '$lib/envelope';
import { forgetSalonAttachments } from '$lib/utils/chat/salonAttachmentSend';
import { ChannelApiError } from '$lib/services/ChannelService';

const CHANNEL = 'channel_12cf41f3-0000-0000-0000-000000000000';

function makeContext(): MessagingContext {
  return {
    conversations: new SvelteMap<string, Conversation>([
      [
        CHANNEL,
        { id: CHANNEL, name: CHANNEL, messages: [], unreadCount: 0, lastMessageAt: 0 } as never,
      ],
    ]),
    userId: 'me',
    authToken: 'copy',
    selectedContact: CHANNEL,
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setAuthToken: vi.fn(),
    setSendError: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

const heavy = { size: 40_000_000, name: 'heavy.mp4', type: 'video/mp4' } as unknown as File;

function rows(ctx: MessagingContext) {
  return ctx.conversations.get(CHANNEL)!.messages;
}

/** Sends the heavy file and returns its row id, the send having returned. */
async function sendHeavy(ctx: MessagingContext): Promise<string> {
  const messaging = useMessaging();
  await messaging.handleSendChat(ctx, 'the caption', {
    files: [{ file: heavy, width: 0, height: 0 } as never],
  });
  expect(rows(ctx)).toHaveLength(1);
  return rows(ctx)[0].id;
}

beforeEach(() => {
  uploads.length = 0;
  posts.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  resetSalonSendGate();
  openSalonSendGate(CHANNEL);
});

afterEach(() => {
  forgetSalonAttachments();
  vi.restoreAllMocks();
});

describe('a heavy file sent in a salon', () => {
  it('is in the thread from the tap and shows the real transfer until the server has it', async () => {
    const ctx = makeContext();
    const id = await sendHeavy(ctx);

    // DRAWN AT THE TAP, before a byte left: the placeholder, the caption, a pending own row.
    const row = rows(ctx)[0];
    expect(row.isOwn).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.awaitingServerId).toBe(true);
    const env = parseEnvelope(row.content);
    expect(env.kind).toBe('media');
    expect(env.kind === 'media' && env.media.mediaId).toBe('');
    expect(env.kind === 'media' && env.caption).toBe('the caption');

    // The upload is running and HELD: the row stays, its view moves with each real progress event.
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploadViewOf(id)?.phase).toBe('preparing');
    uploads[0].transport.onProgress!({ loaded: 10_000_000, total: 40_000_016 });
    expect(uploadViewOf(id)).toMatchObject({ phase: 'uploading', loaded: 10_000_000 });
    uploads[0].transport.onProgress!({ loaded: 30_000_000, total: 40_000_016 });
    expect(uploadViewOf(id)).toMatchObject({ phase: 'uploading', loaded: 30_000_000 });
    expect(rows(ctx).map((m) => m.id)).toEqual([id]);

    // Uploaded: the row names its blob BEFORE the POST, and nothing is posted twice.
    uploads[0].resolve({
      type: 'video',
      mediaId: 'blob-1',
      key: '00'.repeat(32),
      iv: '00'.repeat(12),
      mimeType: 'video/mp4',
      size: 40_000_000,
    });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].messageId).toBe(id);
    const swapped = parseEnvelope(rows(ctx)[0].content);
    expect(swapped.kind === 'media' && swapped.media.mediaId).toBe('blob-1');
    expect(uploadViewOf(id)).toBeUndefined();
    expect(rows(ctx)).toHaveLength(1);

    // The server's row: the echo is re-keyed in place, never drawn twice.
    posts[0].resolve({ id: 'server-row-1', createdAt: new Date(1_000).toISOString() });
    await vi.waitFor(() => expect(rows(ctx)[0].id).toBe('server-row-1'));
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0].status).toBe('sent');
  });

  it('keeps the row with its Retry when the server refuses the upload, and the Retry uploads again', async () => {
    const ctx = makeContext();
    const id = await sendHeavy(ctx);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));

    uploads[0].reject(new ChannelApiError(413, 'PAYLOAD_TOO_LARGE', 'too large'));
    await vi.waitFor(() => expect(uploadViewOf(id)?.phase).toBe('refused'));
    expect(rows(ctx).map((m) => m.id)).toEqual([id]);
    expect(ctx.setSendError).toHaveBeenCalled();

    retryUpload(id);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    expect(rows(ctx).map((m) => m.id)).toEqual([id]);
  });

  it('aborts the transfer and takes the row away on cancel, sending nothing', async () => {
    const ctx = makeContext();
    const id = await sendHeavy(ctx);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].transport.onProgress!({ loaded: 5, total: 100 });

    const cancel = uploadCancelOf(id);
    expect(cancel).toBeTypeOf('function');
    cancel!();

    expect(uploads[0].transport.signal?.aborted).toBe(true);
    expect(rows(ctx)).toHaveLength(0);
    expect(uploadViewOf(id)).toBeUndefined();
    // A late answer of the aborted request changes nothing.
    uploads[0].transport.onProgress!({ loaded: 50, total: 100 });
    expect(uploadViewOf(id)).toBeUndefined();
    expect(posts).toHaveLength(0);
  });

  it('shows the row as queued while its salon is not loaded, uploading nothing yet', async () => {
    resetSalonSendGate();
    const { beginSalonListing } = await import('$lib/utils/graine/salonSendGate');
    beginSalonListing();
    const ctx = makeContext();
    const id = await sendHeavy(ctx);

    expect(uploadViewOf(id)?.phase).toBe('queued');
    expect(uploads).toHaveLength(0);

    openSalonSendGate(CHANNEL);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(rows(ctx).map((m) => m.id)).toEqual([id]);
  });
});
