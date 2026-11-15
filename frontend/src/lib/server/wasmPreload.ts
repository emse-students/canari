/**
 * The inline head script that starts the MLS WASM download BESIDE the JavaScript instead of after it.
 *
 * ## THE MEASUREMENT (local estate, Slow 3G, cold HTTP cache, 2026-10-09)
 *
 * The 2.1 MB binary was requested at 58.8 s and finished at 103.1 s; the 201 JavaScript files it
 * waited for finished at 57 s. `prefetchMlsWasmAtBoot` (`wasmPrefetch.ts`) already removed the PIN
 * round trip from that chain, but it still runs INSIDE the bundle, so it cannot start before the
 * bundle has been fetched, parsed and executed. On a link where the JS alone takes a minute, that
 * is a minute of idle bandwidth-in-waiting for a file that depends on nothing in it.
 *
 * ## WHY THE SCRIPT IS IN `app.html` AND ONLY ITS INPUTS ARE WRITTEN HERE
 *
 * The Content-Security-Policy allows no inline script but those it knows the hash of
 * (`lib/security/cspPolicy.js`), and the hashes of `app.html`'s scripts are computed when the build
 * starts - before the bundler has named the binary. A script carrying the URL would be a new text,
 * and so a refused one, on every build. So the script is FIXED text in `app.html`, and the server
 * writes what varies - the URL and the key prefix - into the attributes of the marker `<meta>` it
 * reads. An attribute is data; no policy is asked about it.
 *
 * ## WHY IT IS A SCRIPT AND NOT A `<link>` WRITTEN INTO `app.html`
 *
 * Two facts decide it, and both are per-visitor:
 *
 *  - **The URL is content-hashed** (`mls_wasm_bg.<hash>.wasm`) and known only to the build. The
 *    server hook imports it with `?url` and writes it here, so it can never name a file the
 *    deploy deleted.
 *  - **Only a browser that has enrolled an MLS device needs the binary.** An anonymous reader of a
 *    public post must not pay 0.8 MB for an engine it will never start - that is the exact guard
 *    `browserHasEnrolledMlsDevice` encodes for the in-bundle prefetch, and it needs `localStorage`,
 *    which the server cannot read. A static `<link rel="preload">` or a `Link:` header would be
 *    unconditional. The script applies the SAME predicate, from the SAME prefix constant.
 *
 * ## WHY THE LATER `fetch` SHARES THE DOWNLOAD
 *
 * `mlsWasmLoader` calls `fetch(url, { credentials: 'same-origin' })`: a CORS-mode request with
 * same-origin credentials. A preload with `as="fetch"` and `crossorigin` (anonymous) has exactly
 * that request mode and credentials mode, so the browser answers the later `fetch` from the
 * download in flight. A mismatch in either - the classic `crossorigin` omission - fetches the file
 * twice, which is why a test pins both attributes.
 *
 * ## WHY `fetchpriority="low"`, AND WHY IT IS NOT ENOUGH
 *
 * Both transfers share one link. Low asks the browser to let the scripts go first, and the browser
 * raises the priority of an in-flight preload when the real `fetch` arrives. **Asking is not
 * getting**: measured 2026-11-09 (production build, gzip, HTTP/1.1, Slow 3G, cold), the 0.88 MB
 * binary took its share of the link from the first second whatever its priority, and the app's
 * JavaScript finished 12-13 s later than without it - on `/chat` (first API call 46.4 s against
 * 34.4 s) and on `/posts` (46.1 s against 33.1 s). Whether an h2 path in front honours the hint is
 * not measured; this module does not depend on it.
 *
 * ## ONLY WHERE THE FIRST SCREEN WAITS FOR THE ENGINE ({@link MLS_FIRST_SCREEN_ROUTES})
 *
 * That cost buys something only where the first screen cannot draw without the binary: the
 * conversation list waits for `mlsService.init` (`docs/wiki/frontend/offline-and-weak-network.md`, section 10.3), so on `/chat` the overlap is worth
 * its 12 s (the binary ends 5 s sooner than if it started after the bundle). Everywhere else - the
 * feed `/` lands on, the calendar, a profile - the screen draws from the API alone, the overlap only
 * delays it, and the in-bundle prefetch (`hooks.client.ts`) still starts the binary the moment the
 * bundle has run. So the marker is filled for those routes only; elsewhere it is left as the native
 * shell leaves it, and the script returns at once.
 */
import { MLS_DEVICE_ID_PREFIX } from '$lib/mls-client/wasmPrefetch';
import { escapeHtmlAttribute } from '$lib/seo/renderHead';

/**
 * The node `app.html` carries and the server hook replaces. A node and not a comment, for the
 * reason the SEO marker is one (`hooks.server.ts`): SvelteKit warns when a transform drops a
 * comment, and a placeholder that survives (Tauri shell) is an inert `<meta>`.
 */
export const WASM_PRELOAD_MARKER = '<meta name="canari-wasm-preload" data-canari-wasm />';

/**
 * Builds the filled marker the `app.html` preload script reads: the content-hashed binary URL in
 * `content`, the enrolled-device key prefix in `data-device-prefix`. The script appends the preload
 * link only when this browser profile holds a key with that prefix. In a native shell nothing fills
 * the marker and the script returns at once: Tauri embeds its frontend, so there is nothing to
 * download.
 *
 * @param wasmUrl the content-hashed URL of `mls_wasm_bg.wasm`, as the bundler resolved it.
 * @returns the `<meta>` element that replaces {@link WASM_PRELOAD_MARKER}.
 */
export function renderWasmPreloadMeta(wasmUrl: string): string {
  return (
    `<meta name="canari-wasm-preload" content="${escapeHtmlAttribute(wasmUrl)}" ` +
    `data-device-prefix="${escapeHtmlAttribute(MLS_DEVICE_ID_PREFIX)}" data-canari-wasm />`
  );
}

/**
 * The routes whose FIRST SCREEN cannot draw before the MLS engine runs: exactly the routes that
 * mount `MainChatPage`, whose list waits for `mlsService.init`. `wasmPreloadRoutes.test.ts` derives
 * that set from `src/routes` and fails when a route starts or stops mounting it, so this list cannot
 * drift from the fact it names.
 */
export const MLS_FIRST_SCREEN_ROUTES: readonly string[] = ['/chat', '/communities'];

/**
 * Whether a document request for `pathname` should start the binary beside its JavaScript.
 *
 * @param pathname the requested path, as SvelteKit decoded it.
 * @returns true for a route of {@link MLS_FIRST_SCREEN_ROUTES} (or a path under one).
 */
export function firstScreenNeedsMls(pathname: string): boolean {
  return MLS_FIRST_SCREEN_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

/**
 * What replaces {@link WASM_PRELOAD_MARKER} in the document served for `pathname`: the filled
 * marker where the first screen waits for the engine, the marker untouched (the script then
 * returns at once) everywhere else.
 *
 * @param pathname the requested path.
 * @param wasmUrl the content-hashed URL of `mls_wasm_bg.wasm`.
 */
export function wasmPreloadMetaFor(pathname: string, wasmUrl: string): string {
  if (!firstScreenNeedsMls(pathname)) return WASM_PRELOAD_MARKER;
  return renderWasmPreloadMeta(wasmUrl);
}
