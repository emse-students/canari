import { MlsDeliveryApi } from './mlsDeliveryApi';

/**
 * The pending pull is the catch-up path of a device that fell behind, so what these tests pin is
 * PROGRESS, not completeness: WP-PENDING-1 was a single deadline over the whole multi-page pull,
 * which a large enough backlog can never meet - and since nothing was ingested until the pull
 * returned, the queue grew forever.
 */
describe('MlsDeliveryApi.pullPendingMessagesJson', () => {
  const page = (n: number, at: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${at}-${i}`, createdAt: at }));

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const api = (fetchFn: ReturnType<typeof vi.fn>) => {
    const a = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchFn as unknown as typeof fetch,
    });
    a.userId = 'u1';
    a.deviceId = 'd1';
    return a;
  };

  it('hands every page to onPage as it lands, and follows the createdAt cursor', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(page(500, '2026-01-01T00:00:00.000Z')))
      .mockResolvedValueOnce(json(page(2, '2026-01-01T00:01:00.000Z')));

    const pages: number[] = [];
    await api(fetchFn).pullPendingMessagesJson({ onPage: (rows) => void pages.push(rows.length) });

    expect(pages).toEqual([500, 2]);
    expect(String(fetchFn.mock.calls[1][0])).toContain(
      `after=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`
    );
  });

  it('keeps the pages already delivered when a later page fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(page(500, '2026-01-01T00:00:00.000Z')))
      .mockRejectedValueOnce(new Error('The operation was aborted'));

    const pages: number[] = [];
    await expect(
      api(fetchFn).pullPendingMessagesJson({ onPage: (rows) => void pages.push(rows.length) })
    ).rejects.toThrow();

    // The point of the fix: an attempt that dies half-way still drained - and ACKed - a page.
    expect(pages).toEqual([500]);
  });

  it('gives each page its own deadline, never one budget for the whole pull', async () => {
    vi.useFakeTimers();
    try {
      // Every page takes just under the per-page budget. Under a single pull-wide deadline the
      // second one would abort; under a per-page deadline both complete.
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(
              () =>
                resolve(
                  json(page(fetchFn.mock.calls.length === 1 ? 500 : 1, '2026-01-01T00:00:00.000Z'))
                ),
              900
            );
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          })
      );

      const pending = api(fetchFn).pullPendingMessagesJson({ pageTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toHaveLength(501);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a page that overruns its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

      const pending = api(fetchFn).pullPendingMessagesJson({ pageTimeoutMs: 1_000 });
      const assertion = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
