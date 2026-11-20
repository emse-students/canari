/**
 * Whether the `connect-src` this runtime ENFORCES lets the page fetch an address - asked BEFORE the
 * request, so an address the policy is certain to refuse is never handed to it.
 *
 * WHY (2026-11-20, review of the code-scanning triage): a picture dragged into a composer from
 * another page arrives as an address, and the composer used to fetch it whatever it named. Every
 * host but Canari's own is outside `connect-src` on the web and in the app alike, so the browser
 * refused the request, wrote a CSP violation to the console, and the refusal came back as an opaque
 * `TypeError` classified as "unreachable" - learning by failing what the policy already said.
 *
 * THE LISTS ARE READ, NEVER RESTATED: the web page's from `cspDirectives.js` (the object
 * `cspPolicy.js` serialises and `csp.test.ts` holds equal to nginx's snippet), the app's from
 * `tauri.conf.json` itself. A release app reads the release policy; the local overlay
 * (`tauri.local.conf.json`) only widens it, so on a local-estate build this answers "refused" for
 * a few hosts the overlay would allow - a narrower answer, never a request the policy refuses.
 *
 * Only the source shapes these two policies use are understood (`'self'`, a bare scheme, a
 * `scheme://host[:port]` origin); `connectAllowlist.test.ts` fails if either list gains another shape, so no
 * source is ever matched by a rule written for a different one.
 */
import { WEB_POLICY_DIRECTIVES } from './cspDirectives.js';
import { app as tauriApp } from '../../../src-tauri/tauri.conf.json';

/** The `connect-src` sources of the policy a runtime is held to, as the policy spells them. */
export function enforcedConnectSources(tauri: boolean): readonly string[] {
  return tauri
    ? tauriApp.security.csp['connect-src'].split(/\s+/).filter(Boolean)
    : WEB_POLICY_DIRECTIVES['connect-src'];
}

/** Whether a source has a shape {@link connectSourceAllows} reads; the test holds every source to it. */
export function isUnderstoodConnectSource(source: string): boolean {
  if (source === 'self' || source === "'self'") return true;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(source);
}

/**
 * Whether one source allows `target`, restricted to the shapes above: `'self'` is the page's origin;
 * a bare scheme allows that scheme (`http:` also allows `https:`); an origin allows itself, an
 * `http`/`ws` origin also its `https`/`wss` upgrade on the same host and port. DELIBERATELY STRICTER
 * than CSP Level 3, which would also let a `wss:` source allow `https:` on its host: a socket origin
 * named for the call signalling is not a statement that pictures may be read from that host, and a
 * narrower answer can only refuse a drop, never make a request the policy refuses.
 */
function connectSourceAllows(source: string, target: URL, pageOrigin: string): boolean {
  if (source === 'self' || source === "'self'") return target.origin === pageOrigin;
  if (!isUnderstoodConnectSource(source)) return false;
  const upgrade: Record<string, string> = { 'http:': 'https:', 'ws:': 'wss:' };
  const schemeAllows = (scheme: string) =>
    target.protocol === scheme || target.protocol === upgrade[scheme];
  if (source.endsWith(':')) return schemeAllows(source.toLowerCase());
  const allowed = new URL(source);
  return schemeAllows(allowed.protocol) && allowed.host === target.host;
}

/**
 * Whether the policy whose `connect-src` is `sources` lets a page at `pageOrigin` fetch `address`.
 *
 * @param address - an absolute address; one that does not parse is never allowed.
 * @param sources - from {@link enforcedConnectSources}.
 * @param pageOrigin - the page's own origin (`location.origin`), what `'self'` names.
 */
export function connectAllows(
  address: string,
  sources: readonly string[],
  pageOrigin: string
): boolean {
  let target: URL;
  try {
    target = new URL(address);
  } catch {
    return false;
  }
  return sources.some((source) => connectSourceAllows(source, target, pageOrigin));
}
