/**
 * A FILE SENT IN A SALON CARRIES A LIVE TOKEN, NOT THE COPY TAKEN AT SIGN-IN.
 *
 * `ctx.authToken` is set once and never renewed, so a tab open for more than the access token's
 * lifetime sent `POST /api/media/upload` out as `401 JWT expired` - shown to the member as "your
 * session expired" while every other call, which asks `getToken`, kept working. The channel branch
 * only asked `getToken` when the copy was EMPTY; it must ask every time.
 *
 * And since 2026-11-02 the upload runs AFTER the send returns, carried by the file's row
 * (`salonAttachmentSend.ts`): every case below reads the row, never a re-staged file.
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

const getTokenMock = vi.fn();
vi.mock('$lib/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/stores/auth')>();
  return { ...actual, getToken: () => getTokenMock() };
});

const uploadMock = vi.fn();
vi.mock('$lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/media')>();
  class FakeMediaService extends actual.MediaService {
    encryptAndUpload(...args: unknown[]) {
      return uploadMock(...args);
    }
  }
  return { ...actual, MediaService: FakeMediaService };
});

// The text half of a send, observed for WHICH conversation it is sent to; the real one otherwise.
const sendChatMessageSpy = vi.fn();
vi.mock('$lib/utils/chat/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/messaging')>();
  return {
    ...actual,
    sendChatMessage: (...args: Parameters<typeof actual.sendChatMessage>) => {
      sendChatMessageSpy(...args);
      return actual.sendChatMessage(...args);
    },
  };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import {
  beginSalonListing,
  openSalonSendGate,
  resetSalonSendGate,
  salonSendWaiterCount,
  settleSalonListing,
} from '$lib/utils/graine/salonSendGate';
import { m } from '$lib/paraglide/messages';
import { forgetSalonAttachments } from '$lib/utils/chat/salonAttachmentSend';
import { uploadViewOf } from '$lib/utils/chat/uploadProgress.svelte';

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
    // A non-empty copy that has long expired: the old code trusted it.
    authToken: 'stale-copy-from-sign-in',
    selectedContact: CHANNEL,
    // Live, like the page's: a test that moves the selection moves what is on screen.
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setAuthToken: vi.fn(),
    setSendError: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

afterEach(() => forgetSalonAttachments());

const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;

/** The row the send drew, which carries the upload from the tap. */
function rowOf(ctx: MessagingContext) {
  const rows = ctx.conversations.get(CHANNEL)!.messages;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('a salon upload asks for a live token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    getTokenMock.mockResolvedValue('fresh-token');
    uploadMock.mockRejectedValue(new Error('stop after the upload call'));
    // The salon is loaded: the upload is not held for it (salonSendGate).
    resetSalonSendGate();
    openSalonSendGate(CHANNEL);
  });

  it("sends getToken()'s token even though ctx.authToken is a non-empty stale copy", async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();

    await messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });

    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][1]).toBe('fresh-token');
    expect(ctx.setAuthToken).toHaveBeenCalledWith('fresh-token');
  });
});

describe('a salon upload before its salon is loaded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    getTokenMock.mockResolvedValue('fresh-token');
    uploadMock.mockRejectedValue(new Error('stop after the upload call'));
    resetSalonSendGate();
  });

  it('WAITS for the salon before uploading anything, its row queued, then uploads', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    beginSalonListing();

    await messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(uploadViewOf(rowOf(ctx).id)?.phase).toBe('queued');

    openSalonSendGate(CHANNEL);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
  });

  it('uploads nothing, names the cause and keeps the row with its Retry when the listing settles without the salon', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const token = beginSalonListing();

    await messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    settleSalonListing(token, 'failed');

    const id = rowOf(ctx).id;
    await vi.waitFor(() => expect(uploadViewOf(id)?.phase).toBe('error'));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(ctx.setSendError).toHaveBeenLastCalledWith(m.chat_send_error_salon_listing_failed());
    // The ROW holds the file now: nothing goes back to the composer, where a second Send would
    // post it beside the row.
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(0);
  });

  it('keeps the caption ON its file row and says nothing on the salon the member moved to', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const token = beginSalonListing();

    await messaging.handleSendChat(ctx, 'the caption', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    // The member moves on while the upload is held, and the listing then settles without the salon.
    (ctx as { selectedContact: string | null }).selectedContact = 'channel_somewhere-else';
    settleSalonListing(token, 'loaded');

    const row = rowOf(ctx);
    await vi.waitFor(() => expect(uploadViewOf(row.id)?.phase).toBe('error'));
    // The caption travels in the file's own message: never sent alone as a text.
    expect(row.content).toContain('the caption');
    expect(sendChatMessageSpy).not.toHaveBeenCalled();
    // The banner of the conversation now on screen is not this send's.
    expect(ctx.setSendError).not.toHaveBeenCalledWith(m.chat_send_error_salon_not_listed());
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(0);
  });

  /**
   * THE COMPOSABLE OUTLIVES A SIGN-OUT. A held upload refused as `session-ended` must leave nothing
   * to the NEXT account: no row, no staged file, no caption sent into the next session's gate.
   */
  it('leaves nothing to the next account when the session ends while the upload is held', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    beginSalonListing();

    await messaging.handleSendChat(ctx, 'the caption', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    // Sign-out: `setGraineRuntime(null)` resets the gate and the selection is cleared.
    (ctx as { selectedContact: string | null }).selectedContact = null;
    resetSalonSendGate();

    await vi.waitFor(() => expect(ctx.conversations.get(CHANNEL)!.messages).toHaveLength(0));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(0);
    expect(sendChatMessageSpy).not.toHaveBeenCalled();
    expect(salonSendWaiterCount(CHANNEL)).toBe(0);
  });
});
