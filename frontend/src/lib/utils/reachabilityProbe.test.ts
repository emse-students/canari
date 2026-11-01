import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { installReachabilityProbe, probeReachability } from '$lib/utils/reachabilityProbe';

describe('the reachability probe', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => connectivity.reset());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('counts ANY answer of our API as reachable: its JSON 502 is a server there and unhappy', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ statusCode: 502, message: 'Bad Gateway' }, { status: 502 })
    ) as unknown as typeof fetch;
    connectivity.notifyServerUnreachable();
    expect(await probeReachability()).toBe(true);
    expect(connectivity.isOffline).toBe(false);
  });

  it.each([
    ["a captive portal's 511", 511, '<html>Network Authentication Required</html>'],
    ["the WAF's HTML 403", 403, '<html>Access denied (Ban)</html>'],
    ["an edge's 5xx page", 502, '<html><h1>502 Bad Gateway</h1></html>'],
  ])(
    '%s is no answer from the server: the probe goes on and offline holds',
    async (_n, status, body) => {
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = vi.fn(
        async () => new Response(body, { status, headers: { 'content-type': 'text/html' } })
      ) as unknown as typeof fetch;
      connectivity.notifyServerUnreachable();
      expect(await probeReachability()).toBe(false);
      expect(connectivity.isOffline).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('NotFromApiError'))).toBe(true);
      vi.restoreAllMocks();
    }
  );

  it('is false only for the ABSENCE of an answer, and asks the unauthenticated version route', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await probeReachability()).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/version$/);
    expect((init.headers ?? {}) as Record<string, string>).not.toHaveProperty('Authorization');
  });

  it('installs itself on the store, idempotently', () => {
    const spy = vi.spyOn(connectivity, 'setReachabilityProbe');
    installReachabilityProbe();
    installReachabilityProbe();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe(probeReachability);
  });
});
