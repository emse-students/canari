import { MlsDeliveryApi } from './mlsDeliveryApi';

describe('MlsDeliveryApi.fetchHistoryBatch', () => {
  it('maps batch response histories to a Map', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          histories: {
            g1: [{ sender_id: 'u1', content: 'c', timestamp: '2024-01-01T00:00:00Z' }],
            g2: [],
          },
          heads: { g1: '7-0' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([
      { groupId: 'g1', afterStreamId: '1-0' },
      { groupId: 'g2' },
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.get('g1')?.rows).toHaveLength(1);
    expect(out.get('g2')?.rows).toEqual([]);
  });

  // The head is what bounds the rest of the walk, so losing it silently would put the archive and
  // the delivery queue back on the same rows without anything failing.
  it('carries the per-group head so the walk can be bounded', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          histories: { g1: [], g2: [] },
          heads: { g1: '12-3' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([{ groupId: 'g1' }, { groupId: 'g2' }]);

    expect(out.get('g1')?.head).toBe('12-3');
    // An empty stream has no head to pin, and that is not an error.
    expect(out.get('g2')?.head).toBeUndefined();
  });

  it('falls back to sequential fetchHistory when batch fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ sender_id: 'u1', content: 'x', timestamp: 't' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([{ groupId: 'g1' }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.get('g1')?.rows).toHaveLength(1);
  });
});

describe('MlsDeliveryApi.fetchHistory', () => {
  const pageResponse = (rows: unknown[], head?: string) =>
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...(head ? { 'X-History-Head': head } : {}),
      },
    });

  /** Typed so the mock keeps `fetch`'s own signature - a loose one is not assignable to it. */
  const fetchMock = (page: Response) =>
    vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(page);

  const apiWith = (fetchFn: ReturnType<typeof fetchMock>) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

  /** The URL the mock was called with, as a URL so query params can be read individually. */
  const calledUrl = (fetchFn: ReturnType<typeof fetchMock>) =>
    new URL(String(fetchFn.mock.calls[0][0]));

  it('reads the stream head out of the response header', async () => {
    const fetchFn = fetchMock(pageResponse([], '42-0'));

    const page = await apiWith(fetchFn).fetchHistory('g1');

    expect(page.head).toBe('42-0');
  });

  it('sends the bound back as `until`, so the server never reads past it', async () => {
    const fetchFn = fetchMock(pageResponse([]));

    await apiWith(fetchFn).fetchHistory('g1', '3-0', undefined, '42-0');

    expect(calledUrl(fetchFn).searchParams.get('after')).toBe('3-0');
    expect(calledUrl(fetchFn).searchParams.get('until')).toBe('42-0');
  });

  it('omits `until` when the walk has no bound yet', async () => {
    const fetchFn = fetchMock(pageResponse([], '9-0'));

    await apiWith(fetchFn).fetchHistory('g1');

    expect(calledUrl(fetchFn).searchParams.has('until')).toBe(false);
  });

  // A server that predates the bound sends no header; the walk must still run, unbounded, exactly
  // as it did before. See docs/wiki/legacy-compatibility.md.
  it('reports no head when the server does not send one', async () => {
    const fetchFn = fetchMock(pageResponse([{ sender_id: 'u1' }]));

    const page = await apiWith(fetchFn).fetchHistory('g1');

    expect(page.head).toBeUndefined();
    expect(page.rows).toHaveLength(1);
  });
});
