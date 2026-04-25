/**
 * Client-side hooks – runs once at app startup before any component renders.
 *
 * On Tauri, wraps `window.fetch` so that **external API calls** go through
 * the native HTTP plugin (bypasses CORS, uses native TLS), while internal
 * SvelteKit requests (route data, HMR, Vite modules) still use the browser's
 * built-in `fetch` so the client-side router keeps working.
 */

// Deep link handler: captures fr.emse.canari://callback?code=…&state=…
// after the system browser completes the OIDC flow on Android.
if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
  import('@tauri-apps/plugin-deep-link')
    .then(({ onOpenUrl }) => {
      onOpenUrl((urls) => {
        for (const raw of urls) {
          try {
            const u = new URL(raw);
            if (u.protocol === 'fr.emse.canari:' && u.host === 'callback') {
              const code = u.searchParams.get('code');
              const state = u.searchParams.get('state');
              const authError = u.searchParams.get('error');
              if (authError) {
                window.location.href = `/auth/callback?error=${encodeURIComponent(authError)}`;
                return;
              }
              if (code && state) {
                // Reuse the existing /auth/callback page which handles dedup + exchange.
                window.location.href = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
              }
            }
          } catch {
            // Malformed URL — ignore.
          }
        }
      });
    })
    .catch(() => {
      // Plugin not available on desktop — no-op.
    });
}

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

        // Cookie-bearing requests (credentials: 'include') MUST use the
        // browser's native fetch. The Tauri HTTP plugin runs in a separate
        // Rust thread whose cookie jar is isolated from the WebView's — it
        // can't write Set-Cookie responses back to the WebView, which breaks
        // HttpOnly session cookies (refresh token). Using native fetch here
        // also prevents a deadlock where the plugin stalls waiting for a
        // cookie-jar sync that never completes.
        if ((init as RequestInit | undefined)?.credentials === 'include') {
          return originalFetch.call(window, input, init);
        }

        return tauriFetch(input, init) as ReturnType<typeof window.fetch>;
      } as typeof window.fetch;
    })
    .catch(() => {
      // May fail during an in-flight page reload; the next load will retry.
    });
}
