/**
 * Client-side hooks – runs once at app startup before any component renders.
 *
 * On Tauri, wraps `window.fetch` so that **external API calls** go through
 * the native HTTP plugin (bypasses CORS, uses native TLS), while internal
 * SvelteKit requests (route data, HMR, Vite modules) still use the browser's
 * built-in `fetch` so the client-side router keeps working.
 */

if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
  import('@tauri-apps/plugin-http')
    .then(({ fetch: tauriFetch }) => {
      const originalFetch = window.fetch;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        // Determine the URL string
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        // Keep browser fetch for relative URLs (SvelteKit internal),
        // Vite dev server, HMR, and data requests.
        if (
          !url ||
          url.startsWith('/') ||
          url.startsWith('http://127.0.0.1:1420') ||
          url.startsWith('http://localhost:1420') ||
          url.includes('__data.json') ||
          url.includes('@vite') ||
          url.includes('node_modules')
        ) {
          return originalFetch.call(window, input, init);
        }

        return tauriFetch(input, init) as ReturnType<typeof window.fetch>;
      } as typeof window.fetch;
    })
    .catch(() => {
      // May fail during an in-flight page reload; the next load will retry.
    });
}
