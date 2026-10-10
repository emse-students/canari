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

/**
 * A WebView custom protocol wearing an `http(s)` URL, which no network client can ever resolve.
 *
 * Tauri serves EVERY registered custom protocol as `http(s)://<scheme>.localhost/` on Windows and
 * Android (`tauri.localhost` for the app's own assets, `ipc.localhost` for the IPC bridge,
 * `asset.localhost` for converted file sources). Matching the SUFFIX rather than listing those three
 * is the point: a plugin may register a scheme tomorrow, and `.localhost` is reserved by RFC 6761
 * precisely so that it never resolves on a network.
 *
 * Getting this wrong broke Tauri's own IPC. Its bridge calls `fetch('http://ipc.localhost/...')`,
 * which matched `^https?://`, was on no exception list, and so went to the HTTP plugin - a network
 * client, asked to reach a host that does not exist. Tauri logged `IPC custom protocol failed,
 * Tauri will now use the postMessage interface instead` and switched ALL IPC to `postMessage` for
 * the rest of the session, on every Android cold start.
 */
function isWebViewCustomProtocol(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.localhost');
  } catch {
    // Not parseable as an absolute URL, so it is not addressing a host at all; the caller's
    // relative-URL branch already keeps those native.
    return false;
  }
}

/** Origins that must stay on the WebView's own fetch even though they are `http(s)`. */
function isDevServerOrInternalUrl(url: string): boolean {
  return (
    isWebViewCustomProtocol(url) ||
    url.startsWith('http://127.0.0.1:1420') ||
    url.startsWith('http://localhost:1420') ||
    url.includes('__data.json') ||
    url.includes('@vite') ||
    url.includes('node_modules')
  );
}

/**
 * Whether a request carries a BINARY body - a `Blob` (so a `File`), `FormData`, an `ArrayBuffer`, a
 * typed array or a stream - as opposed to a string or nothing.
 *
 * It is the property that decides the transport, not the size: the HTTP plugin's JS does
 * `Array.from(new Uint8Array(await request.arrayBuffer()))` and ships the result through `invoke`
 * as JSON, one JS number per body byte. Measured on the Mi 9T (2026-10-10) that is ~85x the body in
 * the Rust process and ~45-50x in the renderer: 13.4 MB cost +1185 MiB / +487 MiB, and 50 MB killed
 * the render process and the whole app. A JSON string body is a few KB and costs nothing visible,
 * so it stays where it was.
 *
 * A STREAM IS NEVER BINARY HERE: a `ReadableStream` or an async iterable cannot be streamed as a
 * request body by WKWebView at all, and the plugin buffers it anyway (`request.arrayBuffer()`), so
 * sending it native would only trade the plugin's behaviour for a failure.
 *
 * A `Request` as the first argument has a body that is ALWAYS a `ReadableStream` and cannot be
 * inspected without consuming it, so what it carries is read from its `Content-Type`, which the
 * constructor derived from the original body: text (`text/*`, JSON, urlencoded, XML) is the plugin's,
 * everything else with a body (`multipart/form-data`, `application/octet-stream`, a typed `Blob`,
 * no type at all) is binary. A `Request` built from a stream is indistinguishable from one built
 * from a `Blob` without a type, and counts as binary: that single case is not detectable.
 */
export function hasBinaryBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  const body = init?.body;
  if (body !== undefined && body !== null) return isBinaryInitBody(body);
  if (typeof Request === 'undefined' || !(input instanceof Request) || input.body === null) {
    return false;
  }
  return !isTextContentType(input.headers.get('content-type'));
}

function isBinaryInitBody(body: BodyInit | AsyncIterable<unknown>): boolean {
  if (typeof body === 'string' || body instanceof URLSearchParams) return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
  if (Symbol.asyncIterator in (body as object)) return false;
  return true;
}

/** Whether a `Content-Type` names a textual body, which the plugin carries at no visible cost. */
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (
    type.startsWith('text/') ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

/** Whether `url` is on one of Canari's own API origins (`origins` are bare `scheme://host[:port]`). */
function isFirstPartyUrl(url: string, origins: readonly string[]): boolean {
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
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
 *
 * A BINARY BODY TO A CANARI API ORIGIN is the second class kept native (the upload transport):
 * the plugin inflates every body byte ~85x in Rust and ~45-50x in the renderer (see
 * {@link hasBinaryBody}), while the WebView streams a `Blob` or `FormData` without a copy. It is
 * restricted to `firstPartyOrigins` because that is the only place CORS is OURS to grant - every
 * Canari service allows the three Tauri WebView origins (`TAURI_WEBVIEW_ORIGINS`, verified from the
 * Android origin against dev's media, social and core upload routes) - while an arbitrary
 * third-party host keeps the plugin, the reason the override exists.
 *
 * @param firstPartyOrigins Canari's service origins (`apiServiceOrigins()`); empty keeps the
 *                          historical behaviour, which is what the unit tests of the other rules use.
 */
export function shouldUseNativeFetch(
  url: string | null | undefined,
  init?: RequestInit,
  input?: RequestInfo | URL,
  firstPartyOrigins: readonly string[] = []
): boolean {
  if (!url) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  if (isDevServerOrInternalUrl(url)) return true;

  // Cookie-bearing requests: the plugin's cookie jar is isolated from the WebView's and cannot
  // write `Set-Cookie` back into it, which breaks the HttpOnly refresh token - and it can deadlock
  // waiting on a cookie-jar sync that never completes.
  if (init?.credentials === 'include') return true;

  return isFirstPartyUrl(url, firstPartyOrigins) && hasBinaryBody(input ?? url, init);
}

/**
 * The `window.fetch` replacement `hooks.client.ts` installs in Tauri: the WebView's own `fetch` for
 * what {@link shouldUseNativeFetch} keeps native, the HTTP plugin's for the rest.
 *
 * Extracted so the hook's real call (URL resolved from the first argument, `init` and `input`
 * passed as the 2nd and 3rd, origins as the 4th) is a function a test can drive; the hook itself
 * runs asynchronously at startup and nothing else can reach it.
 *
 * @param native        The WebView's original `fetch`, already bound to `window`.
 * @param plugin        The HTTP plugin's `fetch`.
 * @param firstPartyOrigins Read PER CALL (`apiServiceOrigins`), never captured once.
 */
export function createRoutedFetch(
  native: typeof fetch,
  plugin: typeof fetch,
  firstPartyOrigins: () => readonly string[]
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    shouldUseNativeFetch(fetchInputUrl(input), init, input, firstPartyOrigins())
      ? native(input, init)
      : plugin(input, init)) as typeof fetch;
}

/** Resolves the URL string of any `fetch` first argument, or `null` when it has none. */
export function fetchInputUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? null;
}
