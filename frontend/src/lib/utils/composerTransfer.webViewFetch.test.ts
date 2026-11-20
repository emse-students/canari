// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * A DROPPED ADDRESS IS FETCHED UNDER THE BROWSER'S RULES ON EVERY PLATFORM. On Tauri
 * `hooks.client.ts` replaces `window.fetch` with a router that hands a third-party `http(s)` address
 * to the HTTP plugin, a network client that applies no CORS. An address another page put in a drag
 * must never get that client: `fetchWebImageFile` uses the WebView's own `fetch`, captured before
 * the replacement.
 */
describe('fetchWebImageFile transport', () => {
  const pristine = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = pristine;
    vi.resetModules();
  });

  it('never hands a dropped address to the fetch installed over the WebView one', async () => {
    const own = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = own as unknown as typeof fetch;
    vi.resetModules();
    const { fetchWebImageFile } = await import('./composerTransfer');

    // What hooks.client.ts does on Tauri once its modules are evaluated.
    const routed = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' })));
    globalThis.fetch = routed as unknown as typeof fetch;

    await expect(fetchWebImageFile('https://img.example/cat.png')).rejects.toMatchObject({
      reason: 'unreachable',
    });
    expect(routed).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledWith('https://img.example/cat.png', {
      mode: 'cors',
      credentials: 'omit',
    });
  });
});
