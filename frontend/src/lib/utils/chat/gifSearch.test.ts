// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://canari.test' }));

import {
  fetchGifPage,
  GIF_SEARCH_NOT_CONFIGURED,
  GifSearchUnavailableError,
  readGifPage,
} from './gifSearch';
import { dropRetiredKlipyCustomerId } from './retiredKlipyCustomerId';

const R = (name: string, width = 4, height = 3) => ({
  url: `https://static.klipy.com/${name}.gif`,
  width,
  height,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchGifPage', () => {
  beforeEach(() => apiFetch.mockReset());

  it('asks CANARI, never the provider, with only the query and the page', async () => {
    apiFetch.mockResolvedValue(
      json({ gifs: [{ id: '1', preview: R('a'), full: R('b') }], hasNext: true })
    );
    const page = await fetchGifPage('  chat noir ', 2);
    const url = new URL(apiFetch.mock.calls[0][0] as string);
    expect(url.origin).toBe('https://canari.test');
    expect(url.pathname).toBe('/api/mls/gifs');
    expect([...url.searchParams.keys()].sort()).toEqual(['page', 'q']);
    expect(url.searchParams.get('q')).toBe('chat noir');
    expect(page).toEqual({ gifs: [{ id: '1', preview: R('a'), full: R('b') }], hasNext: true });
  });

  it('asks for trending with no q at all', async () => {
    apiFetch.mockResolvedValue(json({ gifs: [], hasNext: false }));
    await fetchGifPage('', 1);
    const url = new URL(apiFetch.mock.calls[0][0] as string);
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('says "not configured" only on chat-delivery\'s OWN 503, never on an upstream one', async () => {
    apiFetch.mockResolvedValueOnce(json({ statusCode: 503, code: GIF_SEARCH_NOT_CONFIGURED }, 503));
    await expect(fetchGifPage('a', 1)).rejects.toBeInstanceOf(GifSearchUnavailableError);
    // nginx's own 503 when the service is down, and an edge page that is not JSON at all.
    for (const res of [
      json({ message: 'upstream unavailable' }, 503),
      new Response('<html>503</html>', { status: 503 }),
      json({}, 502),
    ]) {
      apiFetch.mockResolvedValueOnce(res);
      const error = await fetchGifPage('a', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GifSearchUnavailableError);
    }
  });
});

describe('readGifPage', () => {
  it('keeps only results whose two renditions are sized https URLs', () => {
    const page = readGifPage({
      gifs: [
        { id: '1', preview: R('a'), full: R('b') },
        { id: '2', preview: { ...R('c'), url: 'javascript:alert(1)' }, full: R('d') },
        { id: '3', preview: R('e', 0, 3), full: R('f') },
        { preview: R('g'), full: R('h') },
      ],
      hasNext: 'yes',
    });
    expect(page.gifs.map((g) => g.id)).toEqual(['1']);
    expect(page.hasNext).toBe(false);
  });
});

describe('dropRetiredKlipyCustomerId', () => {
  afterEach(() => localStorage.clear());

  it('removes the per-install identifier older builds sent to KLIPY, and only it', () => {
    localStorage.setItem('klipy_cid', 'f0f0');
    localStorage.setItem('other', 'kept');
    dropRetiredKlipyCustomerId();
    expect(localStorage.getItem('klipy_cid')).toBeNull();
    expect(localStorage.getItem('other')).toBe('kept');
  });

  it('is a no-op on a device that never held it', () => {
    expect(() => dropRetiredKlipyCustomerId()).not.toThrow();
  });
});

describe('the rendition picked for a use', () => {
  const r = (width: number) => ({
    url: `https://static.klipy.com/${width}.gif`,
    width,
    height: width,
  });
  const gif = { id: 'a', tiny: r(90), preview: r(200), full: r(400) };

  it('the grid takes the lightest rendition that still covers its tile', async () => {
    const { pickGridRendition } = await import('./gifSearch');
    expect(pickGridRendition(gif, 80).width).toBe(90);
    expect(pickGridRendition(gif, 150).width).toBe(200);
    expect(pickGridRendition(gif, 300).width).toBe(200);
    expect(pickGridRendition({ ...gif, tiny: undefined }, 80).width).toBe(200);
  });

  it('a comment takes the small rendition, the medium one only when that is too narrow', async () => {
    const { commentGifRendition } = await import('./gifSearch');
    expect(commentGifRendition(gif).width).toBe(200);
    expect(commentGifRendition({ ...gif, preview: r(120) }).width).toBe(400);
  });
});
