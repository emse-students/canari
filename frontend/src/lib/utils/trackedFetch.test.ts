// @vitest-environment happy-dom
import { connectivity } from '$lib/stores/connectivity.svelte';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';

/**
 * ONLY OUR API'S ANSWER PROVES THE SERVER IS THERE. Each edge page below is something a device meets
 * in front of the estate, and each used to clear `isOffline` and fire the reconnect listeners (the
 * outbox flush, the owed archive replays) on the say-so of something that is not the server.
 */
const html = (status: number, body: string) => () =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const EDGE_PAGES: Array<[string, () => Response]> = [
  ["a captive portal's 511", html(511, '<html>Network Authentication Required</html>')],
  ["the WAF's HTML 403", html(403, '<html><body>Access denied (Ban)</body></html>')],
  ["an edge's 5xx page", html(502, '<html><h1>502 Bad Gateway</h1></html>')],
];

describe('trackedFetch counts as answered only a response proven to come from our API', () => {
  beforeEach(() => connectivity.reset());

  it.each(EDGE_PAGES)('%s neither clears offline nor fires a reconnect', async (_name, page) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    connectivity.notifyServerUnreachable();
    const reconnect = vi.fn();
    const off = connectivity.onReconnect(reconnect);
    const res = await trackedFetch(vi.fn(async () => page()) as unknown as typeof fetch, '/x', {});
    // The caller still gets the response: who answered is ITS question to act on.
    expect(res.status).toBe(page().status);
    expect(connectivity.isOffline).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
    off();
    debug.mockRestore();
  });

  it.each(EDGE_PAGES)('%s does not mark a reachable server down either', async (_name, page) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await trackedFetch(vi.fn(async () => page()) as unknown as typeof fetch, '/x', {});
    expect(connectivity.isOffline).toBe(false);
    debug.mockRestore();
  });

  it.each([
    ['a 204', () => new Response(null, { status: 204 })],
    ['an empty 200', () => new Response(null, { status: 200 })],
  ])('%s proves nothing about reachability, yet ends a stall streak', async (_n, answer) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stall = () =>
      connectivity.trackRequest().failed(new RequestDeadlineError('read', 20000, 'GET', '/a', 0));
    stall();
    await trackedFetch(vi.fn(async () => answer()) as unknown as typeof fetch, '/x', {});
    stall();
    expect(connectivity.isOffline).toBe(false);
    stall();
    expect(connectivity.isOffline).toBe(true);
    await trackedFetch(vi.fn(async () => answer()) as unknown as typeof fetch, '/x', {});
    expect(connectivity.isOffline).toBe(true);
    debug.mockRestore();
    warn.mockRestore();
  });

  it("the API's JSON answer, whatever its status, clears offline and fires the reconnect", async () => {
    for (const answer of [
      () => Response.json({ ok: true }),
      () => Response.json({ statusCode: 403, message: 'Forbidden' }, { status: 403 }),
      () => Response.json({ statusCode: 502, message: 'Bad Gateway' }, { status: 502 }),
    ]) {
      connectivity.reset();
      connectivity.notifyServerUnreachable();
      const reconnect = vi.fn();
      const off = connectivity.onReconnect(reconnect);
      await trackedFetch(vi.fn(async () => answer()) as unknown as typeof fetch, '/x', {});
      expect(connectivity.isOffline).toBe(false);
      expect(reconnect).toHaveBeenCalledTimes(1);
      off();
    }
  });
});
