import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshFailedError, SessionExpiredError, setToken } from '$lib/stores/auth';
import { connectivity, isTransportFailure } from '$lib/stores/connectivity.svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import {
  DEADLINE_MS,
  MIN_UPLINK_BYTES_PER_S,
  RequestDeadlineError,
  bodyByteLength,
  classOfMethod,
  deadlineFor,
  fetchUnderDeadline,
} from '$lib/utils/requestDeadline';
import { MlsDeliveryApi, DeliveryUnreachableError } from '$lib/mls-client/mlsDeliveryApi';

/** A fetch that never answers but honours its signal, like the real one. */
function stalledFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      );
    })) as unknown as typeof fetch;
}

describe('deadlines: the number is chosen per call class, and scales with what must leave', () => {
  it('reads and writes have their own base, probes the shortest', () => {
    expect(deadlineFor('read', 0)).toBe(DEADLINE_MS.read);
    expect(deadlineFor('write', 0)).toBe(DEADLINE_MS.write);
    expect(DEADLINE_MS.probe).toBeLessThan(DEADLINE_MS.read);
    expect(classOfMethod('get')).toBe('read');
    expect(classOfMethod('HEAD')).toBe('read');
    expect(classOfMethod('POST')).toBe('write');
    expect(classOfMethod('delete')).toBe('write');
  });

  it('a body gets the time it needs to leave at the assumed minimum uplink', () => {
    const oneMiB = 1024 * 1024;
    expect(deadlineFor('write', oneMiB)).toBe(
      DEADLINE_MS.write + Math.ceil((oneMiB / MIN_UPLINK_BYTES_PER_S) * 1000)
    );
    // Strictly longer than the same call without a body: an upload is never cut for being big.
    expect(deadlineFor('write', oneMiB)).toBeGreaterThan(deadlineFor('write', 0));
  });

  it('an explicit override wins, including 0 (no deadline)', () => {
    expect(deadlineFor('read', 0, 5)).toBe(5);
    expect(deadlineFor('read', 0, 0)).toBe(0);
  });

  it('measures the bodies fetch can carry', () => {
    expect(bodyByteLength(null)).toBe(0);
    expect(bodyByteLength('abcd')).toBe(4);
    expect(bodyByteLength(new Blob(['abcdef']))).toBe(6);
    const form = new FormData();
    form.append('a', 'xy');
    form.append('f', new Blob(['12345']));
    expect(bodyByteLength(form)).toBe(7);
  });
});

describe('fetchUnderDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('raises a TYPED error when the response head does not arrive, never a sentence', async () => {
    const p = fetchUnderDeadline(stalledFetch(), 'https://x.test/api/a?q=1', {}, 'read', 1000);
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const e = await caught;
    expect(e).toBeInstanceOf(RequestDeadlineError);
    expect(e).toMatchObject({
      requestClass: 'read',
      deadlineMs: 1000,
      method: 'GET',
      path: '/api/a',
    });
    expect(isTransportFailure(e)).toBe(true);
  });

  it('resolves with the response and disarms the timer once the head is in', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const res = await fetchUnderDeadline(fetchImpl, 'https://x.test/a', {}, 'read', 1000);
    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller's own cancellation is NOT a deadline", async () => {
    const ctrl = new AbortController();
    const p = fetchUnderDeadline(
      stalledFetch(),
      'https://x.test/a',
      { signal: ctrl.signal },
      'read',
      1000
    );
    const caught = p.catch((e) => e);
    ctrl.abort();
    const e = await caught;
    expect(e).not.toBeInstanceOf(RequestDeadlineError);
    expect((e as DOMException).name).toBe('AbortError');
  });
});

describe('apiFetch under a deadline', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    connectivity.reset();
    setToken(
      `h.${btoa(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 }))}.s`
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('a stalled POST is a transport failure: typed, never a session error, never replayed', async () => {
    const fetchMock = vi.fn(stalledFetch());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = apiFetch('https://x.test/api/things', { method: 'POST', body: '{}' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.write + 1_000);
    const e = await p;
    expect(e).toBeInstanceOf(RequestDeadlineError);
    expect(e).not.toBeInstanceOf(SessionExpiredError);
    expect(e).not.toBeInstanceOf(RefreshFailedError);
    // A write of unknown fate is never replayed here.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a stalled GET is retried exactly ONCE, after a jittered pause', async () => {
    const fetchMock = vi.fn(stalledFetch());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = apiFetch('https://x.test/api/things').catch((e) => e);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.read + 1_200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.read + 1_000);
    const e = await p;
    expect(e).toBeInstanceOf(RequestDeadlineError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('two stalls in a row with nothing answered make the server unreachable; one answer clears it', async () => {
    globalThis.fetch = vi.fn(stalledFetch()) as unknown as typeof fetch;
    const p = apiFetch('https://x.test/api/things').catch((e) => e);
    await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS.read + 2_000);
    await p;
    expect(connectivity.isOffline).toBe(true);

    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    await apiFetch('https://x.test/api/things');
    expect(connectivity.isOffline).toBe(false);
  });

  it('a status code is still an answer: a 503 never counts as a stall', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 503 })
    ) as unknown as typeof fetch;
    const res = await apiFetch('https://x.test/api/things', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(connectivity.isOffline).toBe(false);
  });
});

describe('the MLS send POST', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectivity.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('is abandoned at its deadline and surfaces as DeliveryUnreachableError carrying the typed cause', async () => {
    const api = new MlsDeliveryApi({
      historyUrl: 'https://x.test',
      getToken: async () => 't',
      fetchImpl: stalledFetch(),
    });
    const p = api.postApplicationMessage('g1', 'AAAA').catch((e) => e);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.write + 1_000);
    const e = await p;
    expect(e).toBeInstanceOf(DeliveryUnreachableError);
    expect((e as DeliveryUnreachableError).cause).toBeInstanceOf(RequestDeadlineError);
  });
});
