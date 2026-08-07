/**
 * Which `fetch` implementation a request belongs to inside the Tauri WebView.
 *
 * On mobile the app replaces `window.fetch` with the HTTP plugin's, because the WebView's own
 * client cannot reach a third-party origin under the app's custom protocol. The plugin is a
 * NETWORK client living in a Rust thread, so it can only answer `http:` and `https:` - and it
 * answers anything else with `scheme <x> not supported`, which surfaces as a plain rejected
 * promise indistinguishable from a network failure.
 *
 * The decision is a pure function so it can be tested: `hooks.client.ts` installs the override
 * asynchronously at startup, which nothing else can reach.
 */

/** Origins that must stay on the WebView's own fetch even though they are `http(s)`. */
function isDevServerOrInternalUrl(url: string): boolean {
  return (
    url.startsWith('http://127.0.0.1:1420') ||
    url.startsWith('http://localhost:1420') ||
    url.includes('__data.json') ||
    url.includes('@vite') ||
    url.includes('node_modules')
  );
}

/**
 * Whether this request must go to the WebView's ORIGINAL fetch rather than to the HTTP plugin.
 *
 * The rule names what the plugin CAN do, and everything else stays native. That direction is the
 * whole point: it used to enumerate the exceptions to keep native, so a scheme nobody had listed -
 * `blob:` - was handed to the network client, which rejected it with `scheme blob not supported`.
 * That single omission broke every download on Android and iOS, since saving a decrypted
 * attachment reads its object URL back (WP-DL-1). An exception list cannot be complete; a list of
 * what the plugin actually implements can.
 *
 * `blob:`, `data:` and `filesystem:` are the WebView's own to resolve, and a RELATIVE URL is a
 * SvelteKit request that has no business leaving the WebView either.
 */
export function shouldUseNativeFetch(url: string | null | undefined, init?: RequestInit): boolean {
  if (!url) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  if (isDevServerOrInternalUrl(url)) return true;

  // Cookie-bearing requests: the plugin's cookie jar is isolated from the WebView's and cannot
  // write `Set-Cookie` back into it, which breaks the HttpOnly refresh token - and it can deadlock
  // waiting on a cookie-jar sync that never completes.
  return init?.credentials === 'include';
}

/** Resolves the URL string of any `fetch` first argument, or `null` when it has none. */
export function fetchInputUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? null;
}
