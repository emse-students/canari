/**
 * A 401 ON AN UPLOAD RENEWS THE TOKEN AND RETRIES ONCE - it never ends the session by itself.
 *
 * Production, 30 h: 9 `POST /api/media/upload` answered 401 for a stale access token, each followed
 * by a logout and a new sign-in. Only a 401 after a refresh may mean the session is over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
class FakeSessionExpired extends Error {
  constructor() {
    super('expired');
    this.name = 'SessionExpiredError';
  }
}
vi.mock('$lib/stores/auth', () => ({
  getToken: () => Promise.resolve('token'),
  refresh: () => refreshMock(),
  SessionExpiredError: FakeSessionExpired,
}));
vi.mock('$lib/utils/mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

const { MediaService } = await import('$lib/media');

function reply(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const file = () => new File([new Uint8Array(64)], 'p.bin', { type: 'application/octet-stream' });
const authOf = (call: unknown[]) =>
  ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

describe('media upload 401 handling', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('refreshes once and resends the upload with the fresh token', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401))
      .mockResolvedValueOnce(reply(201, { mediaId: 'm1' }));
    refreshMock.mockResolvedValue('fresh');
    const ref = await new MediaService().encryptAndUpload(file(), 'stale', undefined, 'ephemeral');
    expect(ref.mediaId).toBe('m1');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(fetchMock.mock.calls[0])).toBe('Bearer stale');
    expect(authOf(fetchMock.mock.calls[1])).toBe('Bearer fresh');
  });

  it('throws SessionExpiredError when the fresh token is refused too', async () => {
    fetchMock.mockResolvedValue(reply(401));
    refreshMock.mockResolvedValue('fresh');
    await expect(
      new MediaService().encryptAndUpload(file(), 'stale', undefined, 'ephemeral')
    ).rejects.toBeInstanceOf(FakeSessionExpired);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows what refresh threw, without a second upload', async () => {
    fetchMock.mockResolvedValue(reply(401));
    const boom = new Error('refresh unreachable');
    refreshMock.mockRejectedValue(boom);
    await expect(
      new MediaService().encryptAndUpload(file(), 'stale', undefined, 'ephemeral')
    ).rejects.toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for another refusal, which stays a typed MediaUploadError', async () => {
    fetchMock.mockResolvedValue(reply(413));
    await expect(
      new MediaService().encryptAndUpload(file(), 'ok', undefined, 'ephemeral')
    ).rejects.toMatchObject({ status: 413, name: 'MediaUploadError' });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('applies to the raw avatar upload as well', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401))
      .mockResolvedValueOnce(reply(201, { mediaId: 'a1' }));
    refreshMock.mockResolvedValue('fresh');
    expect(await new MediaService().uploadRaw(file(), 'stale')).toBe('a1');
    expect(authOf(fetchMock.mock.calls[1])).toBe('Bearer fresh');
  });
});
