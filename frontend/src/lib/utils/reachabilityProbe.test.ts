import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { installReachabilityProbe, probeReachability } from '$lib/utils/reachabilityProbe';

describe('the reachability probe', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => connectivity.reset());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('counts ANY HTTP answer as reachable: a 502 is a server that is there and unhappy', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 502 })
    ) as unknown as typeof fetch;
    connectivity.notifyServerUnreachable();
    expect(await probeReachability()).toBe(true);
    expect(connectivity.isOffline).toBe(false);
  });

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
