import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamUnavailableError, fetchJson, fetchJsonOrThrow } from './upstream';

const URL_ASKED = 'http://social/api/public/posts/x/preview';

/** Installs a `fetch` that answers `answer()` and returns it for assertions. */
function fakeFetch(answer: () => Promise<Response>) {
  const spy = vi.fn((_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (status: number, body: unknown = { ok: true }) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('fetchJsonOrThrow - a refusal is an answer, an absence of one is not', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the parsed body on a 2xx', async () => {
    fakeFetch(() => json(200, { markdown: 'hi' }));
    await expect(fetchJsonOrThrow(URL_ASKED)).resolves.toEqual({ markdown: 'hi' });
  });

  it.each([400, 401, 403, 404, 410])(
    'returns null, not a throw, for a %i (the service answered)',
    async (status) => {
      fakeFetch(() => json(status));
      await expect(fetchJsonOrThrow(URL_ASKED)).resolves.toBeNull();
    }
  );

  it.each([500, 502, 503, 504])('throws UpstreamUnavailableError for a %i', async (status) => {
    fakeFetch(() => json(status));
    await expect(fetchJsonOrThrow(URL_ASKED)).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it.each([408, 429])(
    'treats a %i as transient, so it is unavailability and never a cached refusal',
    async (status) => {
      fakeFetch(() => json(status));
      await expect(fetchJsonOrThrow(URL_ASKED)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    }
  );

  it('throws UpstreamUnavailableError for a connection reset, naming its cause', async () => {
    fakeFetch(() =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('read ECONNRESET') }))
    );
    const err = await fetchJsonOrThrow(URL_ASKED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect((err as Error).message).toContain('ECONNRESET');
  });

  it('throws UpstreamUnavailableError when the budget runs out, with no wall clock', async () => {
    vi.useFakeTimers();
    const spy = fakeFetch(() => new Promise<Response>(() => {}));
    spy.mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      });
    });
    const pending = fetchJsonOrThrow(URL_ASKED, {}, 1500).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeInstanceOf(UpstreamUnavailableError);
  });

  it('throws UpstreamUnavailableError for a 200 whose body is not JSON', async () => {
    fakeFetch(() => Promise.resolve(new Response('<html>', { status: 200 })));
    await expect(fetchJsonOrThrow(URL_ASKED)).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});

describe('fetchJson keeps its contract for the callers that want a soft failure', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers null for a refusal AND for an unavailable service, logging the second', async () => {
    fakeFetch(() => json(404));
    await expect(fetchJson(URL_ASKED)).resolves.toBeNull();
    fakeFetch(() => json(503));
    await expect(fetchJson(URL_ASKED)).resolves.toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.any(String));
  });
});
