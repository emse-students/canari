import { HISTORY_BATCH_MAX_GROUPS, MlsDeliveryApi } from './mlsDeliveryApi';

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

  // THE DEFECT THIS PINS: the whole list used to go in one request, so a client with more
  // conversations than the server's cap sent something that could only ever be refused. Measured on
  // production with 110 conversations - one 400, then 110 sequential fetches, which is the cost the
  // route exists to avoid. The chunk size is a FACT of the protocol, not something to discover.
  it('never asks for more groups than the server accepts', async () => {
    const bodies: number[] = [];
    const fetchFn = vi.fn().mockImplementation((_url: unknown, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { groups: { groupId: string }[] };
      bodies.push(sent.groups.length);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            histories: Object.fromEntries(sent.groups.map((g) => [g.groupId, []])),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    });
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const groups = Array.from({ length: 110 }, (_, i) => ({ groupId: `g${i}` }));
    const out = await api.fetchHistoryBatch(groups);

    expect(bodies).toEqual([HISTORY_BATCH_MAX_GROUPS, HISTORY_BATCH_MAX_GROUPS, 10]);
    // Chunking is invisible to the caller: every group asked for is a group primed.
    expect(out.size).toBe(110);
  });

  it('sends nothing at all for an empty list', async () => {
    const fetchFn = vi.fn();
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    expect((await api.fetchHistoryBatch([])).size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // A refused chunk must not become a second way of fetching a page. The group arrives at the
  // replay unprimed and the replay reads its own first page - the path every group took before
  // the batch route existed - so a retry here would only hide the refusal.
  it('leaves a refused chunk out of the map instead of re-fetching it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"message":"nope"}', { status: 400 }));
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    const out = await api.fetchHistoryBatch([{ groupId: 'g1' }, { groupId: 'g2' }]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(0);
  });

  // A bare status cannot tell a refusal from an unreachable server, and it was a bare status that
  // let the cap go unnoticed for as long as it did.
  it('accuses, with the server own words, when a chunk is refused', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('{"message":"At most 50 groups per batch"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn,
    });

    await api.fetchHistoryBatch([{ groupId: 'g1' }]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('400');
    expect(String(spy.mock.calls[0][0])).toContain('At most 50 groups per batch');
    spy.mockRestore();
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
