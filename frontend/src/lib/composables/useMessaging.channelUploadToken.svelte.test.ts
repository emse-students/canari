/**
 * A FILE SENT IN A SALON CARRIES A LIVE TOKEN, NOT THE COPY TAKEN AT SIGN-IN.
 *
 * `ctx.authToken` is set once and never renewed, so a tab open for more than the access token's
 * lifetime sent `POST /api/media/upload` out as `401 JWT expired` - shown to the member as "your
 * session expired" while every other call, which asks `getToken`, kept working. The channel branch
 * only asked `getToken` when the copy was EMPTY; it must ask every time.
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
    const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;

    await messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });

    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
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

  it('WAITS for the salon before uploading anything, then uploads', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;
    beginSalonListing();

    const done = messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    expect(uploadMock).not.toHaveBeenCalled();

    openSalonSendGate(CHANNEL);
    await done;
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('uploads nothing and names the cause when the listing settles without the salon', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;
    const token = beginSalonListing();

    const done = messaging.handleSendChat(ctx, '', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    settleSalonListing(token, 'failed');
    await done;

    expect(uploadMock).not.toHaveBeenCalled();
    expect(ctx.setSendError).toHaveBeenLastCalledWith(m.chat_send_error_salon_listing_failed());
    // Still on that salon: the file goes back to its composer.
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(1);
  });

  it('sends the caption of a refused upload to the salon it was written in, and drops its file', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;
    const token = beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'the caption', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    // The member moves on while the upload is held, and the listing then settles without the salon.
    (ctx as { selectedContact: string | null }).selectedContact = 'channel_somewhere-else';
    settleSalonListing(token, 'loaded');
    await done;

    expect(sendChatMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendChatMessageSpy.mock.calls[0][1]).toBe(CHANNEL);
    // The file is NOT put back in the composer of the conversation now on screen, where its next
    // Send would post it; the banner there says it was removed, and why.
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(0);
    expect(ctx.setSendError).toHaveBeenCalledWith(
      m.chat_media_dropped_other_conversation({ cause: m.chat_send_error_salon_not_listed() })
    );
  });

  /**
   * THE COMPOSABLE OUTLIVES A SIGN-OUT. A held upload refused as `session-ended` used to re-stage
   * its file into the composer the NEXT account sees, and send its caption into the next session's
   * gate, where the next account's listing would release it and seal it as that account.
   */
  it('leaves nothing to the next account when the session ends while the upload is held', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const ctx = makeContext();
    const file = { size: 10, name: 'a.pdf', type: 'application/pdf' } as unknown as File;
    beginSalonListing();

    const done = messaging.handleSendChat(ctx, 'the caption', {
      files: [{ file, width: 0, height: 0 } as never],
    });
    await vi.waitFor(() => expect(salonSendWaiterCount(CHANNEL)).toBe(1));
    // Sign-out: `setGraineRuntime(null)` resets the gate and the selection is cleared.
    (ctx as { selectedContact: string | null }).selectedContact = null;
    resetSalonSendGate();
    await done;

    expect(uploadMock).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFilesFor(CHANNEL)).toHaveLength(0);
    expect(sendChatMessageSpy).not.toHaveBeenCalled();
    expect(salonSendWaiterCount(CHANNEL)).toBe(0);
  });
});
