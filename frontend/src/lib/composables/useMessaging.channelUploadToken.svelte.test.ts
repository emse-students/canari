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

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

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
