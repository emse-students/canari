/**
 * AN UPLOAD THAT LOSES ITS LINK TELLS THE CONNECTIVITY STORE (review of #2944).
 *
 * `fetchUpload` carries every media upload - the DM/group outbox's, a salon attachment's, a form's
 * file - and used to go around the store: only `trackedFetch` reported a transport failure, so a link
 * lost mid-upload left `isOffline` false and nothing was owed to the reconnect. It now settles its
 * request through the same `trackRequestOutcome`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/uploadXhr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/uploadXhr')>();
  return {
    ...actual,
    xhrUpload: () => Promise.reject(new actual.UploadNetworkError('/api/media/upload')),
  };
});

import { fetchUpload } from '$lib/media';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { UploadNetworkError } from '$lib/utils/uploadXhr';

afterEach(() => {
  connectivity.notifyServerReachable();
  vi.restoreAllMocks();
});

describe('fetchUpload and the connectivity store', () => {
  it('marks the server unreachable when the upload loses its link', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    connectivity.notifyServerReachable();
    expect(connectivity.serverReachable).toBe(true);

    await expect(
      fetchUpload(
        'https://example.test/api/media/upload',
        () => ({ method: 'POST', body: new Blob([new Uint8Array(10)]) }),
        'token',
        {}
      )
    ).rejects.toBeInstanceOf(UploadNetworkError);

    expect(connectivity.serverReachable).toBe(false);
  });
});
