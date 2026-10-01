/**
 * A MEDIA DOWNLOAD FAILS WITH A TYPE THAT SAYS WHY, DECIDED WHERE THE FAILURE WAS SEEN (2026-10-01).
 *
 * Every failure but a 410 used to be a plain `Error` with the status in its message, so the screen
 * could only say "Impossible de charger le media". Pinned: each way the download path can fail
 * reaches the caller as the type `mediaFailureCause` reads, and a ciphertext that does not decrypt
 * is evicted from the cache - otherwise the retry offered to the reader re-reads the same bytes.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'token' }));
vi.mock('./mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

import { acquireDecryptedMediaBlobUrl } from './mediaBlobCache';
import { mediaFailureCause, MediaDownloadError } from './mediaErrors';
import { encryptMediaBuffer } from '$lib/mediaCrypto';
import type { MediaRef } from '$lib/media';

const BASE = 'https://media.test';
let n = 0;

/** A fresh id per test, so neither the cipher cache nor the in-flight map carries one over. */
function ref(key = '00'.repeat(32), iv = '00'.repeat(12)): MediaRef {
  n += 1;
  return { type: 'image', mediaId: `m${n}`, key, iv, mimeType: 'image/png', size: 4 };
}

/** A Cache API stand-in keyed by URL, enough to see a put and a delete. */
function fakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (k: string) => store.get(k)?.clone(),
    put: async (k: string, r: Response) => void store.set(k, r),
    delete: async (k: string) => store.delete(k),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return store;
}

beforeEach(() => {
  fakeCaches();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function causeOf(r: MediaRef) {
  try {
    await acquireDecryptedMediaBlobUrl(r, BASE);
  } catch (err) {
    return { err, cause: mediaFailureCause(err) };
  }
  throw new Error('expected the download to fail');
}

describe('the download path types its failures at the throw', () => {
  it('a transport failure is "unreachable"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect((await causeOf(ref())).cause).toBe('unreachable');
  });

  it('a 404 is "not-found" and a 410 is "expired"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    expect((await causeOf(ref())).cause).toBe('not-found');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 410 })));
    expect((await causeOf(ref())).cause).toBe('expired');
  });

  it('any other status is "other", carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const { err, cause } = await causeOf(ref());
    expect(cause).toBe('other');
    expect((err as MediaDownloadError).status).toBe(503);
  });

  it('bytes that do not decrypt are "corrupt", and are not served again from the cache', async () => {
    const good = await encryptMediaBuffer(new Uint8Array([1, 2, 3, 4]).buffer);
    const tampered = new Uint8Array(good.ciphertext.slice(0));
    tampered[0] ^= 0xff;
    const fetchMock = vi.fn(async () => new Response(tampered.slice(0)));
    vi.stubGlobal('fetch', fetchMock);
    const r = ref(good.keyHex, good.ivHex);

    expect((await causeOf(r)).cause).toBe('corrupt');
    // The retry downloads again rather than re-reading the damaged copy.
    fetchMock.mockImplementation(async () => new Response(good.ciphertext.slice(0)));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ok');
    await expect(acquireDecryptedMediaBlobUrl(r, BASE)).resolves.toBe('blob:ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
