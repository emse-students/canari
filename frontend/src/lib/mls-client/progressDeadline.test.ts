import { fetchJsonUnderProgressDeadline, StalledRequestError } from './progressDeadline';

/**
 * WHAT A DEADLINE IS ALLOWED TO CONCLUDE.
 *
 * A total deadline concludes "this took too long", which is not a fact about anything: a big answer
 * on a slow link and a dead connection produce the same verdict, so the number guarding it has to
 * cover the largest plausible answer times the slowest plausible link, and no such number exists.
 * These tests pin the question that DOES have an answer - is anything still coming - and the two
 * outcomes it separates.
 */
describe('fetchJsonUnderProgressDeadline', () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  /** A body that arrives in pieces `gapMs` apart, then either ends or goes quiet forever. */
  const dripping = (
    chunks: string[],
    gapMs: number,
    thenClose: boolean
  ): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        const push = () => {
          if (i < chunks.length) {
            controller.enqueue(encode(chunks[i++]));
            setTimeout(push, gapMs);
            return;
          }
          if (thenClose) controller.close();
        };
        setTimeout(push, gapMs);
      },
    });

  /** Only `ok`, `status` and `body` are read, so a real `Response` would add nothing but a mock. */
  const responding = (init: { ok?: boolean; status?: number; body: ReadableStream | null }) =>
    ({ ok: init.ok ?? true, status: init.status ?? 200, body: init.body }) as unknown as Response;

  const run = <T>(fetchImpl: unknown, stallMs: number) =>
    fetchJsonUnderProgressDeadline<T>(
      fetchImpl as typeof fetch,
      'https://example.test/x',
      {},
      stallMs
    );

  it('does not abandon a transfer that is slow but still arriving', async () => {
    vi.useFakeTimers();
    try {
      // Eight seconds for a body, under a one-second deadline: a total deadline aborts this at the
      // first second, and that is the whole defect. Nothing here is ever silent for a full window,
      // so nothing here is in doubt - and no calibration decided that.
      const parts = ['[1,', '2,', '3,', '4,', '5,', '6,', '7,', '8,', '9,', '10]'];
      const fetchFn = vi.fn().mockResolvedValue(responding({ body: dripping(parts, 800, true) }));

      const pending = run<number[]>(fetchFn, 1_000);
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(pending).resolves.toEqual({
        ok: true,
        status: 200,
        body: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a transfer that starts and then stops, and says the answer had begun', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(responding({ body: dripping(['[1,', '2,'], 300, false) }));

      const pending = run(fetchFn, 1_000);
      const assertion = expect(pending).rejects.toBeInstanceOf(StalledRequestError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      // The evidence a stall cannot itself carry: bytes arrived, so the server had an answer and the
      // LINK is what failed. A caller re-asking a smaller question is answering the wrong one.
      await expect(pending).rejects.toMatchObject({ headReceived: true, bytesReceived: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a server that never answers, and says nothing had begun', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

      const pending = run(fetchFn, 1_000);
      const assertion = expect(pending).rejects.toBeInstanceOf(StalledRequestError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      // The other cause, told apart from the one above: no head, so the question may simply be too
      // big to produce - which is the only case asking a smaller one can fix.
      await expect(pending).rejects.toMatchObject({ headReceived: false, bytesReceived: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a non-2xx as a status and drops its body rather than parsing it', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        responding({ ok: false, status: 503, body: { cancel } as unknown as ReadableStream })
      );

    await expect(run(fetchFn, 1_000)).resolves.toEqual({ ok: false, status: 503 });
    // An unread body holds the connection open, and a status is an ANSWER - there is nothing here
    // to wait for and nothing to parse.
    expect(cancel).toHaveBeenCalled();
  });

  it('lets a transport failure through as itself, never as a stall', async () => {
    // A refused connection and a silence are different events. Reaching here having relabelled one
    // as the other is how a caller ends up treating a dead link as a question asked too big.
    const boom = new TypeError('Failed to fetch');
    const fetchFn = vi.fn().mockRejectedValue(boom);

    await expect(run(fetchFn, 1_000)).rejects.toBe(boom);
  });

  it('refuses a 2xx that carries no body instead of failing inside JSON.parse', async () => {
    const fetchFn = vi.fn().mockResolvedValue(responding({ body: null }));

    await expect(run(fetchFn, 1_000)).rejects.toThrow('answered 200 with no body');
  });
});
