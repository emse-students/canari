/**
 * THE WEB DOCUMENT'S CONTENT-SECURITY-POLICY, as SvelteKit's `kit.csp` writes it (kit.config.js).
 *
 * Plain JavaScript on purpose: `kit.config.js` runs before Vite and cannot import TypeScript, and
 * the frontend suite (`csp.test.ts`) and the build check (`scripts/check-built-csp.mjs`) read the
 * same object, so there is one description of the policy and three readers of it.
 *
 * WHO WRITES WHICH HEADER (docs/wiki/infrastructure/cloudflare-edge.md#who-owns-a-response-header):
 *  - an HTML page is answered by SvelteKit, which sends THIS policy plus the hash of every inline
 *    script it emitted (`mode: 'hash'`) - a header on a server-rendered page, a `<meta>` on the
 *    prerendered `/app-shell`. nginx adds no policy of its own to a page;
 *  - every other response (scripts, workers, the MLS binary, JSON, media) carries nginx's
 *    `/etc/nginx/snippets/csp.conf`, which states the SAME directives - `csp.test.ts` holds them
 *    equal, because a worker's policy is its own response's and must allow what the page allows.
 *
 * Values are spelt the way `kit.csp` takes them: keywords WITHOUT their quotes (`self`, `none`),
 * which SvelteKit adds; schemes and hosts as written.
 *
 * WHY EACH SOURCE IS HERE - the code that needs it, so a narrowing can be checked against it:
 *  - `script-src 'self'`: the bundle and its lazy chunks, all under `/_app/immutable/`.
 *  - `script-src 'wasm-unsafe-eval'`: `WebAssembly.instantiate` of the MLS engine
 *    (`src/lib/wasm`, loaded by `mlsWasmLoader`) and of pdf.js's decoders. Without it every
 *    encrypted conversation stops. It allows compiling WebAssembly and nothing else - no `eval`.
 *  - NO `'unsafe-inline'` for scripts: the four inline scripts of `app.html` are allowed by their
 *    hash ({@link inlineScriptHashes}), SvelteKit's own start script by the hash it adds, and an
 *    inline event handler (`onerror="..."` in an HTML string) is refused - none is left.
 *  - `style-src 'unsafe-inline'`: Svelte `style=` attributes and the HTML strings the PDF exports
 *    build (`trombinoscope.ts`) carry inline styles. Styles cannot run code.
 *  - `connect-src 'self'`: every API call - the page and the API share one origin. The estate's own
 *    `wss://` origins are NAMED for both WebSockets (`/api/ws`, `/api/call`): `'self'` matches
 *    `wss:` only under CSP Level 3, and an older Safari refuses the socket without them. The local
 *    estate (`ws://localhost:8081`) relies on `'self'`; it is driven by a current Chrome.
 *    `blob:`: an attachment's decrypted object URL is read back to save it.
 *    `https://static.klipy.com`: a tab still on a bundle older than the GIF relay
 *    (docs/wiki/frontend/modules/chat.md); the current bundle reads GIFs through `/api/mls/gifs/media`.
 *  - `img-src https:`: a GIF pasted from any host is drawn directly (owner decision 2026-10-18,
 *    `gifMediaProxy.ts`). `data:`: generated avatars (`avatar.ts`); `blob:`: decrypted media.
 *  - `font-src data:`: fonts embedded as data URLs by the exports (`calendarExport.ts`).
 *  - `worker-src blob:`: workers built from a `Blob` (mediabunny, snapdom).
 *  - `media-src blob:`: decrypted audio and video.
 *  - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`: the
 *    page embeds no plugin, never moves its base, is framed by nobody and posts no form elsewhere.
 */

import { createHash } from 'node:crypto';
import { parse } from 'parse5';

/** @typedef {Record<string, string[]>} CspDirectives */

/**
 * The directives every web response carries, page or not, before any per-page hash is added.
 *
 * @type {Readonly<CspDirectives>}
 */
export const WEB_POLICY_DIRECTIVES = Object.freeze({
  'default-src': ['self'],
  'script-src': ['self', 'wasm-unsafe-eval'],
  'style-src': ['self', 'unsafe-inline'],
  'connect-src': [
    'self',
    'blob:',
    'wss://canari.emse.fr',
    'wss://canari-emse.fr',
    'wss://www.canari-emse.fr',
    'wss://dev.canari-emse.fr',
    'https://static.klipy.com',
  ],
  'img-src': ['self', 'data:', 'blob:', 'https:'],
  'font-src': ['self', 'data:'],
  'worker-src': ['self', 'blob:'],
  'media-src': ['self', 'blob:'],
  'frame-src': ['self'],
  'form-action': ['self'],
  'object-src': ['none'],
  'frame-ancestors': ['none'],
  'base-uri': ['self'],
});

/** The keywords CSP writes between single quotes; everything else is a scheme or a host. */
const QUOTED_KEYWORDS = new Set([
  'self',
  'none',
  'unsafe-inline',
  'unsafe-eval',
  'unsafe-hashes',
  'wasm-unsafe-eval',
  'strict-dynamic',
  'report-sample',
]);

/**
 * One source as a browser reads it: keywords and hashes quoted, schemes and hosts bare. The same
 * rule SvelteKit applies when it writes the header, so a test can compare its output to ours.
 *
 * @param {string} source a source as `kit.csp` takes it (`self`, `sha256-...`, `blob:`).
 * @returns {string} the source as it appears in a policy (`'self'`, `'sha256-...'`, `blob:`).
 */
export function quoteSource(source) {
  return QUOTED_KEYWORDS.has(source) || /^(nonce|sha\d{3})-/.test(source) ? `'${source}'` : source;
}

/**
 * A directive map serialised the way a `Content-Security-Policy` header spells it.
 *
 * @param {CspDirectives} directives the map, in `kit.csp` spelling.
 * @returns {string} `default-src 'self'; script-src ...` - no trailing semicolon.
 */
export function serializePolicy(directives) {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources.map(quoteSource)].join(' '))
    .join('; ');
}

/**
 * The text of every inline CLASSIC script in an HTML document, in document order, as a browser
 * parses it.
 *
 * READ BY AN HTML PARSER, NEVER BY A REGULAR EXPRESSION: what ends a script element is the
 * tokenizer's business (`</script >`, `</SCRIPT foo>`, a comment that hides a tag), and a pattern that
 * disagrees with the browser about where a script ends computes the hash of a text the browser never
 * runs - or misses a script altogether. parse5 implements the WHATWG tokenizer and tree builder,
 * so it ends a script exactly where a browser does; it only builds a tree, and nothing in it runs.
 *
 * A script with a `src` is allowed by its origin, and a data block (`type="application/json"`,
 * `application/ld+json`) never runs, so neither is returned.
 *
 * @param {string} html the document (or template) text.
 * @returns {string[]} each inline script's text, exactly as the element holds it.
 */
export function inlineScripts(html) {
  /** @type {string[]} */
  const texts = [];
  /** @param {any} node a parse5 node */
  const visit = (node) => {
    if (node.nodeName === 'script') {
      const attribute = (/** @type {string} */ name) =>
        node.attrs.find((/** @type {{ name: string }} */ a) => a.name === name)?.value;
      const type = (attribute('type') ?? '').trim().toLowerCase();
      const classic = type === '' || type === 'text/javascript' || type === 'module';
      if (attribute('src') === undefined && classic) {
        texts.push(
          node.childNodes.map((/** @type {{ value?: string }} */ c) => c.value ?? '').join('')
        );
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content); // a <template>'s own fragment
  };
  visit(parse(html));
  return texts;
}

/**
 * The `sha256-` source of every inline classic script in an HTML document ({@link inlineScripts}),
 * in document order.
 *
 * The hash covers the exact text of the element, whitespace included - which is why it is computed
 * from the file at build time rather than written down: a reformatted `app.html` changes it, and a
 * written-down hash would then refuse the theme script without a word.
 *
 * @param {string} html the document (or template) text.
 * @returns {string[]} `sha256-<base64>` sources, unquoted, as `kit.csp` takes them.
 */
export function inlineScriptHashes(html) {
  return inlineScripts(html).map(
    (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
  );
}

/**
 * The `kit.csp` block of the WEB build: hash mode, the shared directives, and the hashes of the
 * inline scripts `app.html` carries before `%sveltekit.head%` (SvelteKit hashes only the scripts it
 * writes itself, never the template's).
 *
 * Hash and not nonce: a page is cached at the edge for 60 s (`s-maxage`, Dockerfile.frontend's
 * `@ssr`), so a nonce would be served to every visitor of that minute - a hash is the same for all
 * of them and is the one that stays true.
 *
 * @param {string} appHtml the text of `src/app.html`.
 * @returns {{ mode: 'hash', directives: CspDirectives }} the value for `kit.csp`.
 */
export function webDocumentCsp(appHtml) {
  const templateHashes = inlineScriptHashes(appHtml);
  return {
    mode: 'hash',
    directives: {
      ...WEB_POLICY_DIRECTIVES,
      'script-src': [...WEB_POLICY_DIRECTIVES['script-src'], ...templateHashes],
    },
  };
}
