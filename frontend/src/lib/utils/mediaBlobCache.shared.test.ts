/**
 * A SHARED DOWNLOAD IS ABANDONED ONLY WHEN ITS LAST HOLDER LEAVES (user, 2026-10-02).
 *
 * Every video uploaded in the chat showed "Impossible de charger la video" with no thumbnail, and the
 * console said `media not shown (other) ... DOMException: The operation was aborted`. The sent
 * message is re-rendered right after its upload: the first render's effect is torn down while its
 * request is still QUEUED behind `mediaRequestGate`, the second render joins the load already in
 * flight - and that load was bound to the FIRST one's signal, so the joiner received its `AbortError`.
 *
 * The gate is saturated here so the request is genuinely queued, which is the state the defect needs.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'token' }));
vi.mock('./mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

import { acquireDecryptedMediaBlobUrl } from './mediaBlobCache';
import { mediaRequestGate } from './requestGate';
import { encryptMediaBuffer } from '$lib/mediaCrypto';
import type { MediaRef } from '$lib/media';

const BASE = 'https://media.test';
let n = 0;

async function sealed(): Promise<{ ref: MediaRef; ciphertext: ArrayBuffer }> {
  const { ciphertext, keyHex, ivHex } = await encryptMediaBuffer(new Uint8Array([1, 2, 3]).buffer);
  n += 1;
  return {
    ref: {
      type: 'video',
      mediaId: `shared${n}`,
      key: keyHex,
      iv: ivHex,
      mimeType: 'video/mp4',
      size: 3,
    },
    ciphertext,
  };
}

/** Takes every slot of the gate, so whatever is asked next waits in its queue. Returns the key. */
function saturateGate(): () => void {
  const releases: (() => void)[] = [];
  for (let i = 0; i < 3; i++) {
    void mediaRequestGate.run(() => new Promise<void>((resolve) => releases.push(resolve)));
  }
  return () => releases.forEach((release) => release());
}

beforeEach(() => {
  const store = new Map<string, Response>();
  const cache = {
    match: async (k: string) => store.get(k)?.clone(),
    put: async (k: string, r: Response) => void store.set(k, r),
    delete: async (k: string) => store.delete(k),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a download shared by several rows', () => {
  it('still reaches a row that joined it, when the row that started it is torn down while queued', async () => {
    const { ref, ciphertext } = await sealed();
    const fetchMock = vi.fn(async () => new Response(ciphertext.slice(0)));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video');
    const release = saturateGate();

    const first = new AbortController();
    const started = acquireDecryptedMediaBlobUrl(ref, BASE, first.signal).catch(() => {});
    // The re-render: its effect joins the load the first one began, then the first is torn down.
    const joined = acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal);
    first.abort();
    release();

    await expect(joined, 'the joiner is handed the video, not the starter s abort').resolves.toBe(
      'blob:video'
    );
    await started;
    expect(fetchMock, 'one request served both').toHaveBeenCalledTimes(1);
  });

  it('is still abandoned when EVERY holder has left, and never asks the network', async () => {
    const { ref, ciphertext } = await sealed();
    const fetchMock = vi.fn(async () => new Response(ciphertext.slice(0)));
    vi.stubGlobal('fetch', fetchMock);
    const release = saturateGate();

    const a = new AbortController();
    const b = new AbortController();
    const first = acquireDecryptedMediaBlobUrl(ref, BASE, a.signal);
    const second = acquireDecryptedMediaBlobUrl(ref, BASE, b.signal);
    const outcomes = Promise.allSettled([first, second]);
    a.abort();
    b.abort();
    release();

    const [one, two] = await outcomes;
    expect(one.status).toBe('rejected');
    expect(two.status).toBe('rejected');
    expect(fetchMock, 'a row scrolled past by everyone never asks').not.toHaveBeenCalled();
  });

  it('starts a fresh load for a row that arrives after the last holder left', async () => {
    const { ref, ciphertext } = await sealed();
    const fetchMock = vi.fn(async () => new Response(ciphertext.slice(0)));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:again');
    const release = saturateGate();

    const gone = new AbortController();
    const abandoned = acquireDecryptedMediaBlobUrl(ref, BASE, gone.signal).catch(() => {});
    gone.abort();
    // It must not join the doomed load - the starter's abort has not even settled yet.
    const later = acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal);
    release();

    await expect(later).resolves.toBe('blob:again');
    await abandoned;
  });

  it('serves a holder with no signal at all, and never abandons what it joined', async () => {
    const { ref, ciphertext } = await sealed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(ciphertext.slice(0)))
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nosignal');
    const release = saturateGate();

    const gone = new AbortController();
    const starter = acquireDecryptedMediaBlobUrl(ref, BASE, gone.signal).catch(() => {});
    const unsignalled = acquireDecryptedMediaBlobUrl(ref, BASE);
    gone.abort();
    release();

    await expect(unsignalled).resolves.toBe('blob:nosignal');
    await starter;
  });
});
