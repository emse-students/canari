/**
 * Mi 9T, 2026-10-13: one salon open requested every member's avatar and collected 25 `404`s for the
 * members without a photo - 37 in the walk. Whether a face exists is now asked for the whole list in
 * ONE request, and a face without a photo is never requested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn<(url: string) => Promise<Response>>();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (url: string) => apiFetchMock(url) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

const { avatarPhotoPresence } = await import('./avatarPresence');
const { forgetReaderCaches } = await import('./sharedCache');

function answer(withPhoto: string[] | null, status = 200): Response {
  return new Response(JSON.stringify({ withPhoto }), { status });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  forgetReaderCaches();
});

describe('avatarPhotoPresence', () => {
  it('asks ONCE for every face of a salon, and says which ones have a photo', async () => {
    apiFetchMock.mockResolvedValue(answer(['u3', 'u7']));
    const ids = Array.from({ length: 30 }, (_, i) => `u${String(i)}`);

    const answers = await Promise.all(ids.map((id) => avatarPhotoPresence(id)));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toContain('/api/users/avatar-presence?ids=u0,u1,');
    expect(answers.filter((a) => a === true)).toHaveLength(2);
    expect(answers.filter((a) => a === false)).toHaveLength(28);
  });

  it('answers a face it was already told about without asking again', async () => {
    apiFetchMock.mockResolvedValue(answer([]));
    await avatarPhotoPresence('gone');

    expect(await avatarPhotoPresence('gone')).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits a list longer than the server accepts into requests, never truncating it', async () => {
    apiFetchMock.mockImplementation(async () => answer([]));
    const ids = Array.from({ length: 150 }, (_, i) => `v${String(i)}`);

    const answers = await Promise.all(ids.map((id) => avatarPhotoPresence(id)));

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(answers.every((a) => a === false)).toBe(true);
  });

  it('answers null, and remembers nothing, when the gallery could not say', async () => {
    apiFetchMock.mockResolvedValueOnce(answer(null));
    apiFetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    expect(await avatarPhotoPresence('x')).toBeNull();
    expect(await avatarPhotoPresence('x')).toBeNull();
    expect(await avatarPhotoPresence('x')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('forgets what it was told when the reader changes', async () => {
    apiFetchMock.mockResolvedValue(answer([]));
    await avatarPhotoPresence('y');
    forgetReaderCaches();
    await avatarPhotoPresence('y');

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
