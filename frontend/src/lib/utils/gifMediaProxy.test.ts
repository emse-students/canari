/**
 * A GIF IS DRAWN AND READ THROUGH CANARI, NEVER FROM ITS HOST (2026-10-18).
 *
 * Every recipient's `<img>` used to load a sent GIF from KLIPY's CDN, handing KLIPY each reader's
 * address and reading time. The message keeps the original URL; this rewrite, at render time, is
 * what keeps the reader's browser off the CDN. Pinned: KLIPY's CDN goes to the GIF relay with the
 * fragment kept on the end and cut from the relayed URL; any other host is left alone (owner
 * decision: no regression for them); a KLIPY GIF produces nothing without a ticket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tickets = vi.hoisted(() => ({ gif: 'gif-ticket', preview: 'preview-ticket' }));
const ensurePreviewTicket = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket,
  previewTicket: () => tickets.preview,
  gifMediaTicket: () => tickets.gif,
}));

const { fetchGifFile, GifRelayError, isKlipyCdnUrl, proxiedGifUrl } =
  await import('$lib/utils/gifMediaProxy');

const KLIPY = 'https://static.klipy.com/ii/abc/de/f.gif';

beforeEach(() => {
  tickets.gif = 'gif-ticket';
  tickets.preview = 'preview-ticket';
  ensurePreviewTicket.mockClear();
  vi.unstubAllGlobals();
});

describe('isKlipyCdnUrl', () => {
  it('is the CDN over https on its default port, and nothing else', () => {
    expect(isKlipyCdnUrl(KLIPY)).toBe(true);
    expect(isKlipyCdnUrl('https://STATIC.KLIPY.COM/x.gif')).toBe(true);
    expect(isKlipyCdnUrl('http://static.klipy.com/x.gif')).toBe(false);
    expect(isKlipyCdnUrl('https://static.klipy.com:8443/x.gif')).toBe(false);
    expect(isKlipyCdnUrl('https://static.klipy.com.evil.example/x.gif')).toBe(false);
    expect(isKlipyCdnUrl('https://api.klipy.com/x.gif')).toBe(false);
    expect(isKlipyCdnUrl('not a url')).toBe(false);
  });
});

describe('proxiedGifUrl', () => {
  it('sends a KLIPY GIF to the relay, with its ticket', () => {
    const url = new URL(proxiedGifUrl(KLIPY));
    expect(url.hostname).not.toBe('static.klipy.com');
    expect(url.pathname).toBe('/api/mls/gifs/media');
    expect(url.searchParams.get('url')).toBe(KLIPY);
    expect(url.searchParams.get('t')).toBe('gif-ticket');
  });

  it('cuts the size fragment from the relayed URL and keeps it on the end', () => {
    const out = proxiedGifUrl(`${KLIPY}#cn-size=498x280`);
    const url = new URL(out);
    // Not relayed: one GIF is one cache entry whatever size a sender wrote.
    expect(url.searchParams.get('url')).toBe(KLIPY);
    // Still readable off the rewritten URL by anything that reads the declared size.
    expect(url.hash).toBe('#cn-size=498x280');
  });

  it('leaves a GIF from any other host alone - it loads directly, as before', () => {
    // Owner decision 2026-10-18: no regression for giphy/tenor/pasted GIFs; their reader still
    // reaches their host (chat.md says so, with the one line that would route them).
    const foreign = 'https://media.giphy.com/media/abc/giphy.gif';
    expect(proxiedGifUrl(foreign)).toBe(foreign);
    // A KLIPY URL with a query is one the relay refuses, so it is not rewritten either.
    expect(proxiedGifUrl(`${KLIPY}?x=1`)).toBe(`${KLIPY}?x=1`);
  });

  it('answers nothing for a KLIPY GIF while no ticket is held - never a URL certain to fail', () => {
    tickets.gif = '';
    expect(proxiedGifUrl(KLIPY)).toBe('');
    expect(proxiedGifUrl('https://example.org/a.gif')).toBe('https://example.org/a.gif');
  });

  it('leaves a non-http value alone', () => {
    expect(proxiedGifUrl('blob:abc')).toBe('blob:abc');
  });
});

describe('fetchGifFile - a comment GIF read through the relay', () => {
  it('ensures a ticket, reads the relay, and names the file after the GIF', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Blob([new Uint8Array([71, 73, 70])], { type: 'image/gif' }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = await fetchGifFile(KLIPY);

    expect(ensurePreviewTicket).toHaveBeenCalled();
    const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(asked.hostname).not.toBe('static.klipy.com');
    expect(asked.pathname).toBe('/api/mls/gifs/media');
    expect(file.name).toBe('f.gif');
    expect(file.type).toBe('image/gif');
    expect(file.size).toBe(3);
  });

  it('refuses without a ticket rather than fetch an empty URL', async () => {
    tickets.gif = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchGifFile(KLIPY)).rejects.toMatchObject({ failure: 'rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a refused answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 413 }))
    );
    await expect(fetchGifFile(KLIPY)).rejects.toMatchObject({ failure: 'rejected' });
  });

  it('tells a saturated relay (503) from a refusal, so the reader is told to wait', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    const error = await fetchGifFile(KLIPY).catch((e) => e);
    expect(error).toBeInstanceOf(GifRelayError);
    expect(error.failure).toBe('busy');
  });

  it('classifies a transport failure as the network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(fetchGifFile(KLIPY)).rejects.toMatchObject({ failure: 'network' });
  });

  it('refuses a body declared larger than the relay ceiling without reading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array([1]), { headers: { 'content-length': '99999999' } })
      )
    );
    await expect(fetchGifFile(KLIPY)).rejects.toMatchObject({ failure: 'too-large' });
  });

  it('reports progress while the body arrives', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-length': '100' } }))
    );
    const seen: number[] = [];
    const file = await fetchGifFile(KLIPY, { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([0.4, 1, 1]);
    expect(file.size).toBe(100);
  });

  it('times out under its own deadline, and rethrows the caller abort as an abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) reject(init.signal.reason);
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      )
    );
    await expect(fetchGifFile(KLIPY, { timeoutMs: 20 })).rejects.toMatchObject({
      failure: 'timeout',
    });
    const controller = new AbortController();
    const pending = fetchGifFile(KLIPY, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(GifRelayError);
  });
});
