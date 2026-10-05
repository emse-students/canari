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

import { acquireDecryptedMediaBlobUrl, releaseDecryptedMediaBlobUrl } from './mediaBlobCache';
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

  /**
   * THE SENT PICTURE THAT STAYED BROKEN UNTIL A RELOAD (user, 2026-10-05, web, the SENDER only: its
   * bubble drew the blurred placeholder and the file name - the `<img>`'s alt text). The outbox
   * fills the ref, the download starts, and `patchStatus('sent')` replaces the message object a
   * moment later, which re-runs the bubble's media effect. The gate is NOT saturated here - one
   * picture, a free slot - so the first row's request is already ON THE WIRE when that row
   * is re-rendered. Aborting it then changes nothing (the gate only cancels a queued request), yet the
   * load used to leave the map, so the re-rendered row started a SECOND download of the same object.
   * The first one landed and was pooled; the second one's blob URL was then revoked by the pool (the
   * blob already displayed wins) and handed to the row anyway: an `<img>` on a dead URL for good.
   */
  it('keeps a load already on the wire joinable, and never hands out a URL it revoked', async () => {
    const { ref, ciphertext } = await sealed();
    const answers: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    let minted = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:minted-${++minted}`);
    const revoked = new Set<string>();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.add(url));

    const first = new AbortController();
    const started = acquireDecryptedMediaBlobUrl(ref, BASE, first.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The re-render: the first row is torn down while its request runs, the new one asks again.
    first.abort();
    const again = acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal);
    answers[0](new Response(ciphertext.slice(0)));
    // A torn-down row releases what it is handed, as `MessageBubble` and `PostMedia` both do.
    await started.then(() => releaseDecryptedMediaBlobUrl(ref));
    // A second request, if one was made, is answered too - the defect never needed it to fail.
    for (const answer of answers) answer(new Response(ciphertext.slice(0)));

    const url = await again;
    expect(revoked.has(url), `the row was handed ${url}, a revoked URL`).toBe(false);
    expect(fetchMock, 'one request served both renders').toHaveBeenCalledTimes(1);
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
