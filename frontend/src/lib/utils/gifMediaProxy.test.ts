/**
 * A GIF IS DRAWN AND READ THROUGH CANARI, NEVER FROM ITS HOST (2026-10-18).
 *
 * Every recipient's `<img>` used to load a sent GIF from KLIPY's CDN, handing KLIPY each reader's
 * address and reading time. The message keeps the original URL; this rewrite, at render time, is
 * what keeps the reader's browser off the CDN. Pinned: KLIPY's CDN goes to the GIF relay with the
 * fragment kept on the end and cut from the relayed URL; any other host goes to the link-preview
 * proxy (the policy for a foreign GIF); nothing is produced without a ticket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tickets = vi.hoisted(() => ({ gif: 'gif-ticket', preview: 'preview-ticket' }));
const ensurePreviewTicket = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket,
  previewTicket: () => tickets.preview,
  gifMediaTicket: () => tickets.gif,
}));

const { fetchGifFile, isKlipyCdnUrl, proxiedGifUrl } = await import('$lib/utils/gifMediaProxy');

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

  it('sends a GIF from any other host to the link-preview proxy, never to its host', () => {
    const foreign = 'https://media.giphy.com/media/abc/giphy.gif';
    const url = new URL(proxiedGifUrl(foreign));
    expect(url.hostname).not.toBe('media.giphy.com');
    expect(url.pathname).toBe('/api/mls/link-preview/image');
    expect(url.searchParams.get('url')).toBe(foreign);
    expect(url.searchParams.get('t')).toBe('preview-ticket');
  });

  it('answers nothing while no ticket is held - never a URL certain to fail', () => {
    tickets.gif = '';
    tickets.preview = '';
    expect(proxiedGifUrl(KLIPY)).toBe('');
    expect(proxiedGifUrl('https://example.org/a.gif')).toBe('');
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
    await expect(fetchGifFile(KLIPY)).rejects.toThrow('no GIF relay ticket');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a refused answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 413 }))
    );
    await expect(fetchGifFile(KLIPY)).rejects.toThrow('HTTP 413');
  });
});
