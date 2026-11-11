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
    const abandoned = acquireDecryptedMediaBlobUrl(ref, BASE, gone.signal).catch((err) => err);
    gone.abort();
    // The turn ends: the abandonment is decided, and the entry leaves the map.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal);
    release();

    await expect(later).resolves.toBe('blob:again');
    expect((await abandoned) as Error).toBeInstanceOf(Error);
    expect(
      fetchMock,
      'only the later row asked: the abandoned one never left the queue'
    ).toHaveBeenCalledTimes(1);
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
   *
   * Since 2026-11-11 a load nobody holds is stopped on the wire too - but only once the turn is
   * over, so the re-render, which joins in the same turn, still keeps the one request.
   */
  it('keeps a load on the wire for a row re-rendered in the same turn, and never hands out a URL it revoked', async () => {
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

  /**
   * A LOAD NOBODY HOLDS IS STOPPED ON THE WIRE (lead decision, 2026-11-11): a reel wheeled past
   * kept downloading its whole 3 MB, sharing a slow link with the reel being watched.
   */
  it('stops a load on the wire once its last holder leaves and nobody rejoins it', async () => {
    const { ref } = await sealed();
    let wireSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          wireSignal = init.signal ?? undefined;
          wireSignal?.addEventListener('abort', () => reject(wireSignal?.reason));
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const passed = new AbortController();
    const load = acquireDecryptedMediaBlobUrl(ref, BASE, passed.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    passed.abort();

    await expect(load).rejects.toBeDefined();
    expect(wireSignal?.aborted, 'the request itself was aborted').toBe(true);
    expect(
      debug.mock.calls.some((c) => String(c[0]).includes('stopped on the wire')),
      'the abandonment is said'
    ).toBe(true);
    expect(
      debug.mock.calls.some((c) => String(c[0]).includes(ref.key)),
      'the line names the media, never its key'
    ).toBe(false);
  });

  it('never caches a download stopped half way, and a later row downloads it whole', async () => {
    const { ref, ciphertext } = await sealed();
    const put = vi.fn();
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (k: string) => store.get(k)?.clone(),
        put: async (k: string, r: Response) => {
          put(k);
          store.set(k, r);
        },
        delete: async (k: string) => store.delete(k),
      }),
    });
    // The first answer's BODY stalls after its headers, then honours the abort.
    let first = true;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if (!first) return Promise.resolve(new Response(ciphertext.slice(0)));
      first = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(ciphertext.slice(0, 4)));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:whole');

    const passed = new AbortController();
    const load = acquireDecryptedMediaBlobUrl(ref, BASE, passed.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    passed.abort();
    await expect(load).rejects.toBeDefined();
    expect(put, 'nothing partial was cached').not.toHaveBeenCalled();

    await expect(
      acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal)
    ).resolves.toBe('blob:whole');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  /**
   * A HOLDER THAT JOINS AFTER AN AWAIT ARRIVES TOO LATE (review of #3337, F4): the last holder's
   * leaving was decided at the end of its turn, so the joiner starts a fresh load. What that costs
   * is BYTES - the abandoned download's - and nothing else: no partial body reaches the pool (no
   * URL is minted from it) or the Cache API (the copy is written once, whole).
   */
  it('a holder that joins after an await starts afresh: it costs bytes, never a partial file', async () => {
    const { ref, ciphertext } = await sealed();
    const put = vi.fn();
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (k: string) => store.get(k)?.clone(),
        put: async (k: string, r: Response) => {
          put((await r.clone().arrayBuffer()).byteLength);
          store.set(k, r);
        },
        delete: async (k: string) => store.delete(k),
      }),
    });
    let first = true;
    let firstBodyStopped = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if (!first) return Promise.resolve(new Response(ciphertext.slice(0)));
      first = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(ciphertext.slice(0, 4)));
          init.signal?.addEventListener('abort', () => {
            firstBodyStopped = true;
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const minted = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fresh');

    const gone = new AbortController();
    const abandoned = acquireDecryptedMediaBlobUrl(ref, BASE, gone.signal).catch((err) => err);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    gone.abort();
    // An await between the leaving and the joining: the turn is over, the load is decided.
    await Promise.resolve();
    await Promise.resolve();
    const late = acquireDecryptedMediaBlobUrl(ref, BASE, new AbortController().signal);

    await expect(late).resolves.toBe('blob:fresh');
    expect((await abandoned) as Error).toBeInstanceOf(Error);
    expect(firstBodyStopped, 'the abandoned body was stopped').toBe(true);
    expect(fetchMock, 'the cost: a second request').toHaveBeenCalledTimes(2);
    expect(minted, 'one URL, from the whole file').toHaveBeenCalledTimes(1);
    expect(put, 'the Cache API took the whole file once').toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(ciphertext.byteLength);
  });
});
