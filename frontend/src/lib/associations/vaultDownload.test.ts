import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A VAULT DOCUMENT THE SERVER NO LONGER HOLDS IS A TYPE, NOT A SENTENCE.
 *
 * On production (2026-09) a vault document's blob had been swept and the page answered with a raw
 * `Download failed: 410` and a generic "download failed" the member could only retry. The 410 is a
 * permanent fact - only a new upload replaces the file - so it is classified where it is thrown,
 * and the cases below pin that the classification reads the STATUS, never the message.
 */

const request = vi.fn();

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => request(...args),
}));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => '' }));

const { fetchVaultCiphertext } = await import('./vaultDownload');
const { isMediaPurgedError } = await import('$lib/utils/mediaErrors');

const MEDIA_ID = 'fbc9ddca-0000-4000-8000-000000000000';

beforeEach(() => request.mockReset());

describe('fetchVaultCiphertext', () => {
  it('returns the packed bytes on success', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    request.mockResolvedValue(new Response(bytes, { status: 200 }));

    const out = await fetchVaultCiphertext(MEDIA_ID);

    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));
    expect(request).toHaveBeenCalledWith(`/api/media/${MEDIA_ID}`);
  });

  it('throws MediaPurgedError on a 410 - the file is gone and must be uploaded again', async () => {
    request.mockResolvedValue(new Response(null, { status: 410 }));

    const err = await fetchVaultCiphertext(MEDIA_ID).catch((e: unknown) => e);

    expect(isMediaPurgedError(err)).toBe(true);
  });

  it('does NOT call any other refusal purged - a 404 or a 500 may be transient', async () => {
    for (const status of [404, 500, 502]) {
      request.mockResolvedValue(new Response(null, { status }));

      const err = await fetchVaultCiphertext(MEDIA_ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(isMediaPurgedError(err)).toBe(false);
    }
  });
});
