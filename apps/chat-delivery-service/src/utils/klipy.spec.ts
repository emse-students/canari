/// <reference types="jest" />

/**
 * THE KLIPY SEAM: WHAT LEAVES FOR KLIPY, AND WHAT COMES BACK TO A CLIENT.
 *
 * Two promises are pinned here. Out: the URL carries the query, the page and one shared customer
 * id - nothing that identifies a reader. Back: only an id, two URLs and their declared sizes; a
 * result without a size is left out and counted, because the grid cannot lay it out without a
 * shift.
 */
import {
  GIF_PAGE_SIZE,
  KLIPY_SHARED_CUSTOMER_ID,
  KlipyHttpError,
  KlipyMalformedAnswerError,
  KlipyUnreachableError,
  fetchKlipyPage,
  klipyPageUrl,
  mapKlipyItems,
} from './klipy';

const sized = (url: string, width: number, height: number) => ({ gif: { url, width, height } });
const U = (name: string) => `https://static.klipy.com/ii/${name}.gif`;

describe('mapKlipyItems', () => {
  it('keeps the declared size of the preview and of the sent rendition, and nothing else', () => {
    const { gifs, dropped } = mapKlipyItems([
      {
        id: 7,
        title: 'tracked',
        file: { sm: sized(U('s'), 220, 124), md: sized(U('m'), 498, 280) },
      },
    ]);
    expect(gifs).toEqual([
      {
        id: '7',
        preview: { url: U('s'), width: 220, height: 124 },
        full: { url: U('m'), width: 498, height: 280 },
      },
    ]);
    expect(dropped).toBe(0);
  });

  it('adds the smallest rendition only when it is really smaller than the preview', () => {
    const { gifs } = mapKlipyItems([
      {
        id: 1,
        file: {
          xs: sized(U('x1'), 90, 50),
          sm: sized(U('s1'), 220, 124),
          md: sized(U('m1'), 498, 280),
        },
      },
      // No xs: nothing to add.
      { id: 2, file: { sm: sized(U('s2'), 220, 124), md: sized(U('m2'), 498, 280) } },
      // An xs as wide as the sm is no lighter: it is not offered.
      {
        id: 3,
        file: {
          xs: sized(U('x3'), 220, 124),
          sm: sized(U('s3'), 220, 124),
          md: sized(U('m3'), 498, 280),
        },
      },
      // The preview itself fell back to xs: it must not be offered twice.
      { id: 4, file: { xs: sized(U('x4'), 90, 50), md: sized(U('m4'), 498, 280) } },
    ]);
    expect(gifs[0].tiny).toEqual({ url: U('x1'), width: 90, height: 50 });
    expect(gifs[1].tiny).toBeUndefined();
    expect(gifs[2].tiny).toBeUndefined();
    expect(gifs[3].preview.url).toBe(U('x4'));
    expect(gifs[3].tiny).toBeUndefined();
  });

  it('leaves out and COUNTS a result with no declared size - it could not be laid out', () => {
    const { gifs, dropped } = mapKlipyItems([
      { id: 1, file: { sm: { gif: { url: U('a') } }, md: { gif: { url: U('b') } } } },
      { id: 2, file: { sm: sized(U('c'), 0, 10), md: sized(U('d'), 10, 10) } },
      { file: { sm: sized(U('e'), 1, 1) } },
    ]);
    // #2 still has a sized medium rendition, used for the grid too.
    expect(gifs.map((g) => g.id)).toEqual(['2']);
    expect(gifs[0].preview.url).toBe(U('d'));
    expect(dropped).toBe(2);
  });

  it('refuses a rendition that is not https - it would reach an <img> on the reader side', () => {
    const { gifs, dropped } = mapKlipyItems([
      { id: 3, file: { md: sized('javascript:alert(1)', 10, 10) } },
      { id: 4, file: { md: sized('http://static.klipy.com/x.gif', 10, 10) } },
      null,
    ]);
    expect(gifs).toEqual([]);
    expect(dropped).toBe(3);
  });
});

describe('klipyPageUrl', () => {
  it('carries the query, the page and the SHARED customer id - no reader identifier', () => {
    const url = new URL(klipyPageUrl('KEY', 'chat noir', 2));
    expect(url.origin).toBe('https://api.klipy.com');
    expect(url.pathname).toBe('/api/v1/KEY/gifs/search');
    expect([...url.searchParams.keys()].sort()).toEqual(['customer_id', 'page', 'per_page', 'q']);
    expect(url.searchParams.get('q')).toBe('chat noir');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('per_page')).toBe(String(GIF_PAGE_SIZE));
    expect(url.searchParams.get('customer_id')).toBe(KLIPY_SHARED_CUSTOMER_ID);
  });

  it('asks for trending when there is no query', () => {
    const url = new URL(klipyPageUrl('KEY', '', 1));
    expect(url.pathname).toBe('/api/v1/KEY/gifs/trending');
    expect(url.searchParams.has('q')).toBe(false);
  });
});

describe('fetchKlipyPage', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends no header naming the reader and maps the answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          data: { data: [{ id: 1, file: { md: sized(U('m'), 4, 3) } }], has_next: true },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await fetchKlipyPage('KEY', 'hello', 1);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(klipyPageUrl('KEY', 'hello', 1));
    const headerNames = Object.keys((calls[0].init.headers ?? {}) as Record<string, string>).map(
      (h) => h.toLowerCase()
    );
    expect(headerNames.sort()).toEqual(['accept', 'user-agent']);
    expect(calls[0].init.signal).toBeDefined();
    expect(result.page).toEqual({
      gifs: [
        {
          id: '1',
          preview: { url: U('m'), width: 4, height: 3 },
          full: { url: U('m'), width: 4, height: 3 },
        },
      ],
      hasNext: true,
    });
    expect(result.received).toBe(1);
  });

  it('reads a short page as the end when KLIPY sends no has_next', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ data: { data: [] } }), { status: 200 })
    ) as typeof fetch;
    expect((await fetchKlipyPage('KEY', '', 1)).page.hasNext).toBe(false);
  });

  it('types a transport failure as unreachable and a non-JSON body as malformed', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(fetchKlipyPage('KEY', 'x', 1)).rejects.toBeInstanceOf(KlipyUnreachableError);
    global.fetch = jest.fn(async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(fetchKlipyPage('KEY', 'x', 1)).rejects.toBeInstanceOf(KlipyMalformedAnswerError);
  });

  it('throws a typed KlipyHttpError on a non-2xx answer', async () => {
    global.fetch = jest.fn(async () => new Response('', { status: 429 })) as typeof fetch;
    const error = await fetchKlipyPage('KEY', 'x', 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KlipyHttpError);
    expect((error as KlipyHttpError).status).toBe(429);
  });
});
