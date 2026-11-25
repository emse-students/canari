/**
 * THE SERVER HALF: which requests are answered with the interstitial, and with which headers.
 * Server-only (it hashes with `node:crypto`); `detect.ts` is the half a page may import.
 *
 * VENDORED BYTE-IDENTICALLY, like `detect.ts`: the source is Canari's
 * `libs/leave-in-app-browser/gate.ts`. Owner decision of 2026-11-25, Canari's
 * docs/wiki/frontend/leaving-in-app-browsers.md.
 */
import { createHash } from 'node:crypto';
import { detectMetaInAppBrowser, type MetaInAppBrowser } from './detect';

/**
 * Paths never answered with the interstitial, whatever asks for them: the APIs, the build's
 * assets, the association files (Apple's and Google's fetchers must always read those), and
 * authentik's outposts - a forward-auth check answers its proxy with a status, and a 200 from the
 * interstitial there would read as "authenticated". Only a top-level document is ever gated anyway
 * (`isTopLevelDocument`); these are the belt to that.
 */
export const GATE_EXEMPT_PREFIXES: readonly string[] = [
  '/api/',
  '/_app/',
  '/.well-known/',
  '/outpost.goauthentik.io/',
];

/** The marker the interstitial carries for the app's own link, filled per request or left empty. */
export const APP_LINK_META = '<meta name="leave-iab-app" content="" />';

/** The part of a request this gate reads - a `Request`, or anything shaped like one. */
export interface GateRequest {
  method: string;
  headers: { get(name: string): string | null };
}

/**
 * Whether the request is a top-level navigation to a page: `GET`/`HEAD`, and `Sec-Fetch-Dest:
 * document` when the browser sends that header, else an `Accept` that asks for HTML. A fetch, an
 * image, a script or a frame is never one, so an API call or an asset is never gated.
 */
export function isTopLevelDocument(request: GateRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** The in-app browser to send away from `pathname`, or null when the request is let through. */
export function gatedInAppBrowser(request: GateRequest, pathname: string): MetaInAppBrowser | null {
  if (GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  if (!isTopLevelDocument(request)) return null;
  return detectMetaInAppBrowser(request.headers.get('user-agent') ?? '');
}

/** The SHA-256 source expression CSP uses for an inline block's exact text. */
function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The text of the one element `tag` in `html`, or a thrown error naming it. */
function onlyBlock(html: string, tag: 'script' | 'style'): string {
  const blocks = [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  if (blocks.length !== 1) throw new Error(`the interstitial must hold exactly one <${tag}>`);
  return blocks[0][1];
}

/**
 * The interstitial's own Content-Security-Policy: nothing but its one script and its one style,
 * each by its hash, so the page can load nothing and run nothing else. Computed from the bytes
 * served, so it cannot drift from them.
 */
export function interstitialCsp(html: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspHash(onlyBlock(html, 'script'))}`,
    `style-src ${cspHash(onlyBlock(html, 'style'))}`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The interstitial's headers. `no-store`: it must never be kept by a cache and served to a real
 * browser; `Vary: User-Agent` says the same URL answers differently by client; `noindex` keeps it
 * out of every index.
 */
export function interstitialHeaders(html: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': interstitialCsp(html),
    'cache-control': 'no-store',
    vary: 'User-Agent',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

/** `value` safe inside a double-quoted HTML attribute. */
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The interstitial's body, with the app's own link (iOS only - Android's exit reaches the app by
 * itself) written into its marker when the site has one for this page.
 */
export function interstitialBody(html: string, appLinkHref: string | null): string {
  if (!html.includes(APP_LINK_META)) throw new Error('the interstitial lost its app link marker');
  if (!appLinkHref) return html;
  return html.replace(
    APP_LINK_META,
    `<meta name="leave-iab-app" content="${attribute(appLinkHref)}" />`
  );
}

/** What a site tells the gate. */
export interface GateOptions {
  /** The interstitial's exact bytes (`interstitial.html`). */
  html: string;
  /** The site's name in the log line. */
  site: string;
  /** The app's own link for this page on iOS, or null. Canari only. */
  appLinkFor?: (url: URL) => string | null;
  /** Where the one line per interstitial goes. */
  log: (line: string) => void;
}

/**
 * The interstitial for this request, or null to let it through. Logs one line per interstitial -
 * the site, the app, the system and the path's first segment, never the full URL or a query - which
 * is the population the readings are measured against.
 */
export function leaveInAppBrowserResponse(
  request: GateRequest,
  url: URL,
  options: GateOptions
): Response | null {
  const browser = gatedInAppBrowser(request, url.pathname);
  if (!browser) return null;
  const route = `/${url.pathname.split('/')[1] ?? ''}`;
  options.log(
    `[leave-iab] interstitial served site=${options.site} app=${browser.app} os=${browser.os} ` +
      `ios=${browser.iosMajor ?? '-'} route=${route}`
  );
  const body = interstitialBody(options.html, options.appLinkFor?.(url) ?? null);
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: interstitialHeaders(options.html),
  });
}
