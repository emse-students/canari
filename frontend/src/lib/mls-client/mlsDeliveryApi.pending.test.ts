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
      .mockResolvedValueOnce(json(page(2, '2026-01-01T00:01:00.000Z')))
      .mockResolvedValueOnce(json([]));

    const pages: number[] = [];
    await api(fetchFn).pullPendingMessagesJson({ onPage: (rows) => void pages.push(rows.length) });

    expect(pages).toEqual([500, 2]);
    expect(String(fetchFn.mock.calls[1][0])).toContain(
      `after=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`
    );
  });

  it('does not read a SHORT page as the end of the queue - only an empty one proves that', async () => {
    // The server bounds a page in bytes, so it answers a 500-row request with however many rows fit
    // in a megabyte. Measured on production the day that shipped: 53 rows for a 500-row ask, and a
    // client terminating on `batch.length < limit` stopped there with 870 frames still queued. The
    // row count of an answer says nothing about what is left; only an empty answer does.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(page(53, '2026-01-01T00:00:00.000Z')))
      .mockResolvedValueOnce(json(page(53, '2026-01-01T00:01:00.000Z')))
      .mockResolvedValueOnce(json([]));

    const rows = await api(fetchFn).pullPendingMessagesJson();

    expect(rows).toHaveLength(106);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('keeps the pages already delivered when a later page fails for good', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(page(500, '2026-01-01T00:00:00.000Z')))
      .mockRejectedValue(new Error('The operation was aborted'));

    const pages: number[] = [];
    await expect(
      api(fetchFn).pullPendingMessagesJson({ onPage: (rows) => void pages.push(rows.length) })
    ).rejects.toThrow();

    // The point of the fix: an attempt that dies half-way still drained - and ACKed - a page.
    expect(pages).toEqual([500]);
  });

  it('halves the page rather than giving up, because a page that does not arrive was asked too big', async () => {
    // The failure this pins: a device whose frames carried media needed 12 MB for 500 rows, aborted
    // on its own deadline having received nothing, ACKed nothing, and met the same 12 MB every time.
    // Asking for less is the only move that changes the answer - and it is a change to the REQUEST,
    // so it terminates on a proof rather than on a clock.
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(json(page(3, '2026-01-01T00:00:00.000Z')))
      .mockResolvedValueOnce(json([]));

    const rows = await api(fetchFn).pullPendingMessagesJson();

    expect(rows).toHaveLength(3);
    const limits = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));
    expect(limits).toEqual(['500', '250', '125', '125']);
  });

  it('gives up only at a page of ONE row, in a bounded number of attempts', async () => {
    // A single row cannot be "too big to aggregate" - there is nothing left to aggregate - so a
    // failure there is a genuine transport failure and reporting it is the honest answer. Measured
    // on production the same day: the largest frame in the entire queue was 87 kB, and none exceeded
    // 1 MB, so a one-row page really is small enough to cross any link this app runs on.
    const fetchFn = vi.fn().mockRejectedValue(new Error('aborted'));

    await expect(api(fetchFn).pullPendingMessagesJson()).rejects.toThrow('aborted');

    const limits = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));
    expect(limits).toEqual(['500', '250', '125', '62', '31', '15', '7', '3', '1']);
  });

  it('keeps the smaller page for the pages that follow, never growing back', async () => {
    // Deliberate: the halving converges DOWNWARD on a size this link can carry. Restoring 500 after
    // a success would re-ask the question that just failed on every subsequent page, which is how
    // the original defect stayed alive across attempts.
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(json(page(250, '2026-01-01T00:00:00.000Z')))
      .mockResolvedValueOnce(json(page(1, '2026-01-01T00:01:00.000Z')))
      .mockResolvedValueOnce(json([]));

    await api(fetchFn).pullPendingMessagesJson();

    const limits = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));
    expect(limits).toEqual(['500', '250', '250', '250']);
  });

  it('gives each page its own deadline, never one budget for the whole pull', async () => {
    vi.useFakeTimers();
    try {
      // Every page stays just under the per-page window. Under a single pull-wide deadline the
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

      const pending = api(fetchFn).pullPendingMessagesJson({ stallTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toHaveLength(501);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not halve a page that is merely SLOW, only one that goes silent', async () => {
    vi.useFakeTimers();
    try {
      // THE DEFECT THIS ITEM CLOSES. The deadline used to measure the total time a page took, so a
      // large page on a slow link was indistinguishable from one that had stopped arriving - it was
      // aborted, then halved, on a link that was working the whole time. Here the body takes six
      // times the window to arrive and is never quiet for a full one, so there is nothing to doubt:
      // one request, at the size originally asked.
      const body = JSON.stringify(page(500, '2026-01-01T00:00:00.000Z'));
      const slices = Array.from({ length: 12 }, (_, i) =>
        body.slice(Math.floor((i * body.length) / 12), Math.floor(((i + 1) * body.length) / 12))
      );
      const fetchFn = vi.fn().mockImplementation(() => {
        const first = fetchFn.mock.calls.length === 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const parts = first ? slices : ['[]'];
              let i = 0;
              const push = () => {
                if (i < parts.length) {
                  controller.enqueue(new TextEncoder().encode(parts[i++]));
                  setTimeout(push, 500);
                  return;
                }
                controller.close();
              };
              setTimeout(push, 500);
            },
          }),
        } as unknown as Response);
      });

      const pending = api(fetchFn).pullPendingMessagesJson({ stallTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toHaveLength(500);

      const limits = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));
      expect(limits).toEqual(['500', '500']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a page that goes silent, then asks a smaller one', async () => {
    vi.useFakeTimers();
    try {
      // A server that never answers at all: the deadline fires on every attempt, the halving runs
      // its full ladder, and the pull ends by REPORTING rather than by hanging. The deadline is a
      // hang-guard here, not the thing deciding how big a page may be - that is the server's byte
      // budget, and the client's halving when the server is older than it.
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

      const pending = api(fetchFn).pullPendingMessagesJson({ stallTimeoutMs: 1_000 });
      // The failure is NAMED, not just counted: nothing had begun to arrive, which is the one cause
      // asking a smaller page can fix.
      const assertion = expect(pending).rejects.toThrow('no response head');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      // Nine attempts, bounded by the ladder and not by a retry counter anyone has to maintain.
      expect(fetchFn).toHaveBeenCalledTimes(9);
    } finally {
      vi.useRealTimers();
    }
  });
});
