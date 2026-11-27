import { BadRequestException, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { decode as decodeEntities } from 'html-entities';
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';

/**
 * Returns true if `ip` is an IPv4 address a server-side fetch must never reach:
 * loopback, RFC-1918, link-local, carrier-grade NAT, and the reserved blocks.
 * Anything unparseable is reported as private - a value we cannot classify is
 * not a value we should connect to.
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4) return true;
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;

  const [a, b, c] = parts;
  return (
    // 0.0.0.0/8 "this host": on Linux a connection to 0.0.0.0 lands on loopback,
    // so it reaches every service bound to the wildcard address.
    a === 0 ||
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC 6598 carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. the 169.254.169.254 cloud metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && c === 0) || // RFC 6890 protocol assignments
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && b >= 18 && b <= 19) || // RFC 2544 benchmarking
    a >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, incl. 255.255.255.255
  );
}

/**
 * Extracts the IPv4 address embedded in an IPv4-mapped, IPv4-compatible or NAT64
 * IPv6 address, in either notation (`::ffff:127.0.0.1` and `::ffff:7f00:1` are the
 * same address). Returns `null` when `normalized` carries no embedded IPv4.
 *
 * This exists because such an address is a full-strength SSRF vector: the socket
 * ends up on the embedded IPv4, so the embedded IPv4 is what has to be judged.
 */
function embeddedIpv4(normalized: string): string | null {
  const match = /^(?:::ffff:|::|64:ff9b::)(.+)$/.exec(normalized);
  if (!match) return null;

  const rest = match[1];
  if (isIP(rest) === 4) return rest;

  const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hextets) return null;

  const high = Number.parseInt(hextets[1], 16);
  const low = Number.parseInt(hextets[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Returns true if `ip` is an IPv6 address a server-side fetch must never reach:
 * unspecified, loopback, unique-local, link-local, multicast, or any form that
 * embeds a private IPv4.
 */
function isPrivateIpv6(ip: string): boolean {
  // Drop a zone identifier (`fe80::1%eth0`) before matching on the prefix.
  const normalized = ip.toLowerCase().split('%')[0];

  const mapped = embeddedIpv4(normalized);
  if (mapped) return isPrivateIpv4(mapped);

  return (
    normalized === '::' || // unspecified, the IPv6 counterpart of 0.0.0.0
    normalized === '::1' || // loopback
    /^f[cd]/.test(normalized) || // fc00::/7 unique-local
    /^fe[89ab]/.test(normalized) || // fe80::/10 link-local - NOT just the fe80: hextet
    normalized.startsWith('ff') // ff00::/8 multicast
  );
}

/**
 * Returns true if `ip` is an address that must not be reachable from a
 * server-side fetch (IPv4 or IPv6). Used to block link-preview requests from
 * being pointed at internal infrastructure (SSRF prevention, CWE-918).
 */
export function isPrivateIpAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/**
 * Strips the brackets the WHATWG URL parser keeps around an IPv6 host, so the
 * literal-address check sees `::1` rather than `[::1]`. Without this `isIP` says
 * "not an address" and the whole literal branch is skipped.
 */
function unbracketHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Parses `rawUrl` and performs SSRF-prevention checks before allowing the server
 * to fetch it. Specifically it rejects: non-http(s) schemes, embedded credentials,
 * localhost hostnames, and any hostname that DNS-resolves to a private/loopback IP.
 * Throws `BadRequestException` on any violation; returns the parsed `URL` on success.
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only http/https URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new BadRequestException('URL credentials are not allowed');
  }

  const hostname = unbracketHost(parsed.hostname.toLowerCase());
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new BadRequestException('Localhost URLs are not allowed');
  }

  if (isIP(hostname) && isPrivateIpAddress(hostname)) {
    throw new BadRequestException('Private network URLs are not allowed');
  }

  const resolved = await resolveOrClassify(hostname);
  if (resolved.length === 0) {
    throw new BadRequestException('Host cannot be resolved');
  }
  assertPublicAddresses(resolved);

  return parsed;
}

/**
 * The resolver codes that are an ANSWER about the name: it does not exist (NXDOMAIN) or holds no
 * address. Only these may become the caller's `400`; a name that does not exist today will not
 * exist on the next render either.
 */
const NAME_HAS_NO_ADDRESS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Resolves `hostname`, CLASSIFYING A FAILURE AT THE THROW so no caller reads the resolver's prose.
 *
 * `ENOTFOUND`/`ENODATA` are an answer about the URL ({@link NAME_HAS_NO_ADDRESS}): a `400`. Anything
 * else - `EAI_AGAIN` above all, the resolver saying "try again" - is the resolver saying NOTHING,
 * the same class as a connect timeout: {@link UpstreamUnreachableError}. It used to escape raw, so
 * Nest's `ExceptionsHandler` printed a stack at ERROR and answered `500` for a passing resolver
 * hiccup that was neither the request's fault nor a bug.
 */
async function resolveOrClassify(hostname: string): Promise<LookupAddress[]> {
  try {
    return await lookup(hostname, { all: true });
  } catch (error) {
    const code = resolverCode(error);
    // Not the resolver's answer (no `getaddrinfo` code): a bug of ours, never dressed as an outage.
    if (code === null) throw error;
    if (NAME_HAS_NO_ADDRESS.has(code)) {
      throw new BadRequestException('Host cannot be resolved');
    }
    throw new UpstreamUnreachableError(hostname, error, code);
  }
}

/**
 * The resolver's code when `error` IS the resolver's failure - a string `code` on an error whose
 * `syscall` is `getaddrinfo`, as both node and bun throw it - and `null` for anything else, which
 * only a bug can produce here and which must surface as one.
 */
function resolverCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return typeof code === 'string' && syscall === 'getaddrinfo' ? code : null;
}

/**
 * Throws `BadRequestException` if any resolved address is a private/loopback IP.
 * Shared by the pre-fetch URL check ({@link assertSafeExternalUrl}) and the
 * connect-time dispatcher guard ({@link ssrfSafeLookup}).
 */
export function assertPublicAddresses(addresses: readonly Pick<LookupAddress, 'address'>[]): void {
  for (const entry of addresses) {
    if (isPrivateIpAddress(entry.address)) {
      throw new BadRequestException('Private network URLs are not allowed');
    }
  }
}

/**
 * A `dns.lookup` drop-in that additionally rejects any resolution to a
 * private/loopback address. Used as the undici connector's `lookup` so the IP
 * the socket actually connects to is the one validated - closing the
 * DNS-rebinding TOCTOU window between the pre-fetch check and the socket
 * connect (SSRF / CWE-918). It faithfully honours both `dns.lookup` callback
 * shapes (`all: true` -> address array, otherwise `(address, family)`).
 */
export function ssrfSafeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    for (const entry of addresses) {
      if (isPrivateIpAddress(entry.address)) {
        callback(
          Object.assign(new Error(`Blocked connection to private address for host ${hostname}`), {
            code: 'ESSRFBLOCKED',
          }),
          '',
          0
        );
        return;
      }
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}

/**
 * ONE BUDGET FOR EVERY OUTBOUND PREVIEW FETCH, AND EVERY MECHANISM THAT CAN ENFORCE IT AGREES.
 *
 * There used to be two. The endpoint armed an `AbortController` at 4 000 ms while this dispatcher
 * left undici's own defaults in place, and the error recorded on 2026-08-15 was undici's:
 * `ConnectTimeoutError ... timeout: 10000ms`. So the STATED budget was not the one that fired, which
 * makes the stated one a comment rather than a rule - and nobody could say which of the two the
 * system actually had. Both are now set from here: the abort bounds the whole operation (the
 * redirect chain plus the oEmbed follow-up), and these bound each individual leg of it.
 */
export const OUTBOUND_BUDGET_MS = 4000;

/**
 * Shared undici dispatcher for outbound link-preview fetches. Pins every
 * connection to a validated, public-only resolved address via
 * {@link ssrfSafeLookup}. Pass it as the `dispatcher` of a global `fetch` call.
 */
export const ssrfSafeDispatcher = new Agent({
  connect: { lookup: ssrfSafeLookup, timeout: OUTBOUND_BUDGET_MS },
  headersTimeout: OUTBOUND_BUDGET_MS,
  bodyTimeout: OUTBOUND_BUDGET_MS,
});

/**
 * The upstream said NOTHING - a connect timeout, a DNS failure, an abort, a socket that died.
 *
 * IT IS A TYPE BECAUSE THE CALLER'S DECISION DEPENDS ON IT and no wording can carry that: a site
 * that answered something unusable is an ANSWER about the URL and may be remembered, while "I could
 * not reach it" is not an answer about the URL at all - remembering that one replays a passing
 * outage to every reader for the whole of a TTL, and reporting it as a 400 tells the client its
 * request was malformed when the request was fine.
 */
export class UpstreamUnreachableError extends Error {
  /**
   * Named `reason` rather than `cause`: this service targets ES2021, where `Error.cause` is not
   * declared, which is the same reason {@link errorCause} exists.
   */
  constructor(
    readonly host: string,
    readonly reason: unknown,
    /** The resolver's code when the failure was the DNS lookup itself (`EAI_AGAIN`), else absent. */
    readonly dnsCode?: string
  ) {
    super(
      `${host} unreachable${dnsCode ? ` (dns ${dnsCode})` : ''}: ${String(errorCause(reason) ?? reason)}`
    );
    this.name = 'UpstreamUnreachableError';
  }
}

/** The response type of {@link ssrfSafeFetch} - undici's `Response`, not the global one. */
export type SsrfSafeResponse = UndiciResponse;

/**
 * Reads the `cause` of a thrown value, or `undefined` when it carries none.
 *
 * `fetch` reports every transport failure as a bare `TypeError: fetch failed`
 * and puts the real reason in `cause`, so the cause is the only diagnosable
 * part. Accessed through a cast because this service targets ES2021, where
 * `Error.cause` is not yet declared.
 */
export function errorCause(error: unknown): unknown {
  return error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
}

/**
 * Performs an outbound fetch pinned to {@link ssrfSafeDispatcher}.
 *
 * It exists to keep the dispatcher and the `fetch` that consumes it in ONE
 * place, because they must come from the SAME undici copy. Node bundles its own
 * undici behind the global `fetch`, and handing it an `Agent` built from the
 * `undici` package throws `InvalidArgumentError: invalid onRequestStart method`
 * before a single byte leaves the process - the two copies disagree on the
 * dispatch handler interface. The failure is total (every outbound preview) and
 * silent (a plain `TypeError: fetch failed`), so the pairing is enforced here
 * rather than left to each call site.
 */
export function ssrfSafeFetch(
  url: string,
  init?: Omit<UndiciRequestInit, 'dispatcher'>
): Promise<SsrfSafeResponse> {
  return undiciFetch(url, { ...init, dispatcher: ssrfSafeDispatcher });
}

/**
 * The ONE place a page's markup text becomes plain text: decodes the full HTML5 named-entity set
 * and decimal / hex numeric references, exactly once (so `&amp;rsquo;` yields the literal
 * `&rsquo;`, never `'`). An unknown entity stays as written. The result is plain text: the card
 * renders it as text, so a decoded `&lt;script&gt;` is shown and never executed.
 *
 * @param scope - `attribute` for a tag attribute (browser rule: a legacy entity without its `;`
 * is left alone when followed by `=` or an alphanumeric), `body` for element text.
 */
export function decodeHtmlEntity(
  value: unknown,
  scope: 'attribute' | 'body' = 'attribute'
): string {
  const normalized = typeof value === 'string' ? value : '';
  return decodeEntities(normalized, { level: 'html5', scope });
}

/** Parses all `<meta>` tags from an HTML string and returns their attributes as key/value maps. */
export function extractMetaTags(html: string): Array<Record<string, string>> {
  const tags: string[] = html.match(/<meta\b[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z:-]+)\s*=\s*(["'])(.*?)\2/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(tag)) !== null) {
      const rawKey = String(match[1] ?? '').toLowerCase();
      const rawValue = String(match[3] ?? '').trim();
      if (!rawKey) continue;
      attrs[rawKey] = decodeHtmlEntity(rawValue);
    }
    return attrs;
  });
}

/** Finds the `content` attribute of the first `<meta>` tag whose `property` or `name` matches `key` (case-insensitive). */
export function extractMetaContent(html: string, key: string): string | null {
  const normalizedKey = key.toLowerCase();
  for (const attrs of extractMetaTags(html)) {
    const attrKey = attrs.property || attrs.name;
    if (attrKey?.toLowerCase() === normalizedKey && attrs.content) {
      return attrs.content;
    }
  }
  return null;
}

/** Extracts and trims the text content of the first `<title>` element, or returns `null` if absent. */
export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntity(match[1].trim(), 'body') : null;
}

/** Parses all `<link>` tags from an HTML string and returns their attributes as key/value maps. */
export function extractLinkTags(html: string): Array<Record<string, string>> {
  const tags: string[] = html.match(/<link\b[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z:-]+)\s*=\s*(["'])(.*?)\2/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(tag)) !== null) {
      const rawKey = String(match[1] ?? '').toLowerCase();
      const rawValue = String(match[3] ?? '').trim();
      if (!rawKey) continue;
      attrs[rawKey] = decodeHtmlEntity(rawValue);
    }
    return attrs;
  });
}

/** Largest dimension declared in a `sizes` attribute ("32x32 16x16"), or 0 when absent/"any". */
function largestDeclaredSize(sizes?: string): number {
  if (!sizes) return 0;
  let largest = 0;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const width = Number.parseInt(token.split('x')[0] ?? '', 10);
    if (Number.isFinite(width) && width > largest) largest = width;
  }
  return largest;
}

/**
 * Resolves the site's own favicon from its `<link rel="icon">` declarations.
 *
 * The page has already been downloaded to read its Open Graph tags, so the icon
 * costs nothing extra - and the site is the only authority on it. A third-party
 * icon service only knows hosts it has crawled, so it answers a generic
 * placeholder for anything private or unindexed, which is indistinguishable from
 * a real icon to the caller.
 *
 * Falls back to the conventional `/favicon.ico`, which browsers request whether
 * or not a page declares it. Returns an absolute URL; never throws.
 *
 * @param baseUrl - the URL the HTML was SERVED from, which a declared `href` and
 * the `/favicon.ico` convention both hang off. After a redirect that is not the
 * link that was written - see `buildLinkPreviewPayload`.
 */
export function extractIconUrl(html: string, baseUrl: URL): string {
  let best: { href: string; score: number } | null = null;

  for (const attrs of extractLinkTags(html)) {
    const rel = attrs.rel?.toLowerCase();
    const href = attrs.href;
    if (
      !rel ||
      !href ||
      !/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel)
    ) {
      continue;
    }
    // Prefer a declared size, then an apple-touch-icon (always a large PNG),
    // then anything else - a 16x16 .ico is the last resort, not the first hit.
    const score = largestDeclaredSize(attrs.sizes) || (rel.includes('apple-touch-icon') ? 180 : 1);
    if (best && score <= best.score) continue;

    try {
      const resolved = new URL(href, baseUrl);
      // The href is attacker-controlled markup and this URL is handed straight to
      // an <img src>. `new URL` resolves almost anything against a base rather
      // than throwing - including `javascript:` and `data:`, which stay absolute
      // - so the scheme has to be checked, not merely the parse.
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      best = { href: resolved.toString(), score };
    } catch {
      // Keep looking rather than failing the whole preview over one bad tag.
    }
  }

  return best?.href ?? new URL('/favicon.ico', baseUrl.origin).toString();
}

/**
 * Extracts Open Graph / standard meta tags from `html` and returns a normalised
 * link-preview payload (url, title, description, image, siteName, icon), each
 * field truncated to a safe display length.
 *
 * TWO URLS, BECAUSE A REDIRECT MAKES THEM DIFFER. `targetUrl` is the link as the
 * message wrote it: it is the payload's identity - what the card shows and what
 * it opens - and it is the only thing the cache is keyed on. `baseUrl` is where
 * the HTML actually came from, and it is the ONLY thing a relative reference may
 * resolve against. They are the same URL for most links and different for every
 * shortener, every `http` -> `https` hop and every locale redirect; resolving an
 * `og:image` of `/files/event/1.jpg` against a `bit.ly` link built
 * `https://bit.ly/files/event/1.jpg`, a 404 this service then cached for six
 * hours (measured on production 2026-09-23).
 *
 * @param baseUrl - defaults to `targetUrl`, which is correct when nothing redirected.
 */
export function buildLinkPreviewPayload(
  html: string,
  targetUrl: URL,
  baseUrl: URL = targetUrl
): LinkPreviewPayload {
  const title = extractMetaContent(html, 'og:title') || extractTitle(html) || targetUrl.hostname;
  const description =
    extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description') || '';
  const siteName = extractMetaContent(html, 'og:site_name') || targetUrl.hostname;

  const rawImage = extractMetaContent(html, 'og:image');
  let image = '';
  if (rawImage) {
    try {
      image = new URL(rawImage, baseUrl).toString();
    } catch {
      image = '';
    }
  }

  return {
    url: targetUrl.toString(),
    title: title.slice(0, 180),
    description: description.slice(0, 280),
    image,
    siteName: siteName.slice(0, 120),
    icon: extractIconUrl(html, baseUrl),
  };
}

/** The link-preview payload every producer in this file returns. */
export interface LinkPreviewPayload {
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
  icon?: string;
}

/**
 * The `href` of the page's own oEmbed endpoint, or null when it declares none.
 *
 * oEmbed is the one metadata contract a site publishes *for* embedders, so a
 * page that has it usually describes itself better there than in its Open Graph
 * tags - Spotify, Vimeo, Bandcamp, Flickr and X all do. Discovery is a `<link
 * rel="alternate" type="application/json+oembed">` in the markup we have
 * already downloaded, so finding it costs nothing; only following it costs a
 * request.
 *
 * The href comes from someone else's markup, so the scheme is checked rather
 * than the parse: `new URL(href, base)` happily resolves `javascript:` and
 * `data:` instead of throwing.
 *
 * @param baseUrl - the URL the HTML was SERVED from, for the same reason
 * `buildLinkPreviewPayload` takes one: a relative `href` means nothing against a
 * link that redirected elsewhere.
 */
export function extractOEmbedEndpoint(html: string, baseUrl: URL): string | null {
  for (const attrs of extractLinkTags(html)) {
    if (attrs.rel?.toLowerCase() !== 'alternate') continue;

    const type = attrs.type?.toLowerCase() ?? '';
    if (type !== 'application/json+oembed' && type !== 'text/json+oembed') continue;
    if (!attrs.href) continue;

    try {
      const resolved = new URL(attrs.href, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      return resolved.toString();
    } catch {
      // A malformed declaration is not a reason to fail the whole preview.
    }
  }

  return null;
}

/** The three oEmbed fields worth merging into a preview. All optional, by the spec. */
export interface OEmbedData {
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
  providerName?: string;
}

/**
 * Why an oEmbed endpoint gave nothing usable, CLASSIFIED WHERE IT HAPPENED:
 * - `refused` - the SSRF guard refused the endpoint the page declared (a private address, a name
 *   with no address, another scheme): the page pointed us somewhere we will not go;
 * - `unreachable` - the endpoint said nothing (DNS, connect, abort, a body that died);
 * - `status` / `not-json` / `malformed` - it ANSWERED, with something unusable: a fact about a
 *   third party's site that nobody here can act on.
 */
export type OEmbedFailureKind = 'refused' | 'unreachable' | 'status' | 'not-json' | 'malformed';

/** The typed "no enrichment" of {@link fetchOEmbedData}: its kind, and the evidence. */
export class OEmbedUnavailable {
  constructor(
    readonly kind: OEmbedFailureKind,
    readonly detail: string
  ) {}
}

/**
 * Follows a discovered oEmbed endpoint and returns the fields we can use.
 *
 * Goes through the same SSRF guard as the page fetch: the endpoint is declared
 * by the page, so it is exactly as attacker-controlled as the URL that was
 * pasted. Never throws for the endpoint's sake - a preview that already has Open Graph data must
 * not be lost because the optional enrichment failed; only a bug of ours propagates - and never
 * swallows either: every
 * failure comes back as an {@link OEmbedUnavailable} the caller logs, where it used to be a bare
 * `null` that said nothing about which of five things went wrong.
 */
export async function fetchOEmbedData(
  endpoint: string,
  signal?: AbortSignal
): Promise<OEmbedData | OEmbedUnavailable> {
  let safeUrl: URL;
  try {
    safeUrl = await assertSafeExternalUrl(endpoint);
  } catch (error) {
    if (error instanceof UpstreamUnreachableError) {
      return new OEmbedUnavailable('unreachable', error.message);
    }
    if (error instanceof BadRequestException)
      return new OEmbedUnavailable('refused', error.message);
    // Reachable: the guard rethrows what is not the resolver's answer (`resolverCode`) - a bug.
    throw error;
  }

  let response: UndiciResponse;
  let raw: string;
  try {
    response = await ssrfSafeFetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': 'CanariLinkPreview/1.0',
        accept: 'application/json',
      },
    });
    if (!response.ok) return new OEmbedUnavailable('status', `answered ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('json')) {
      return new OEmbedUnavailable('not-json', `content-type ${contentType || 'none'}`);
    }
    raw = (await response.text()).slice(0, 100_000);
  } catch (error) {
    // Every throw of a fetch or of reading its body is the transport: the site said nothing.
    return new OEmbedUnavailable('unreachable', String(errorCause(error) ?? error));
  }

  let data: {
    title?: unknown;
    author_name?: unknown;
    thumbnail_url?: unknown;
    provider_name?: unknown;
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return new OEmbedUnavailable('malformed', 'not a JSON object');
    }
    data = parsed as typeof data;
  } catch (error) {
    return new OEmbedUnavailable('malformed', String(error).slice(0, 120));
  }

  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  return {
    title: asString(data.title),
    authorName: asString(data.author_name),
    thumbnailUrl: asString(data.thumbnail_url),
    providerName: asString(data.provider_name),
  };
}

/**
 * Merges oEmbed data into a payload built from the page's meta tags.
 *
 * Open Graph wins wherever both speak, because it is what the site chose to
 * show in a preview; oEmbed only fills gaps and adds the one thing Open Graph
 * has no field for - the author. That ordering is what keeps the enrichment
 * safe to apply blindly: a site with good tags is never made worse by it.
 *
 * Returns a new payload; the input is not modified.
 *
 * Both URLs, and for the two jobs `buildLinkPreviewPayload` separates: `targetUrl`
 * is the identity the placeholder title is recognised by, `baseUrl` is what a
 * relative thumbnail resolves against.
 *
 * @param baseUrl - defaults to `targetUrl`, which is correct when nothing redirected.
 */
export function mergeOEmbedIntoPayload(
  payload: LinkPreviewPayload,
  oembed: OEmbedData | null,
  targetUrl: URL,
  baseUrl: URL = targetUrl
): LinkPreviewPayload {
  if (!oembed) return payload;

  // `buildLinkPreviewPayload` falls back to the hostname when the page declares
  // no title, so "the title is the hostname" is how a missing title presents.
  const titleIsPlaceholder = !payload.title || payload.title === targetUrl.hostname;

  let description = payload.description;
  if (!description && oembed.authorName) {
    description = oembed.providerName
      ? `${oembed.providerName} • ${oembed.authorName}`
      : oembed.authorName;
  }

  let image = payload.image;
  if (!image && oembed.thumbnailUrl) {
    try {
      const resolved = new URL(oembed.thumbnailUrl, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        image = resolved.toString();
      }
    } catch {
      // Keep the empty image rather than a value we could not resolve.
    }
  }

  return {
    ...payload,
    title: (titleIsPlaceholder && oembed.title ? oembed.title : payload.title).slice(0, 180),
    description: description.slice(0, 280),
    image,
    siteName:
      payload.siteName === targetUrl.hostname && oembed.providerName
        ? oembed.providerName.slice(0, 120)
        : payload.siteName,
  };
}

const GALLERY_HOST = 'gallery.mitv.fr';
/** An Immich album id, exactly. */
const GALLERY_ALBUM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GALLERY_ALBUM_RE = /^\/albums\/([0-9a-f-]+)\/?$/i;

/**
 * The wide (1200x630) cover a card draws large, for every album whatever its visibility.
 *
 * The hero banner is about 640 CSS px wide, so the 400px square cover that fills the tile is
 * upscaled about three times there (the visibly pixelated card of 2026-11-26). MiGallery serves
 * BOTH covers without a key for every album, private included - an external site embeds one from an
 * `<img>`, which carries no key (MiGallery's `og-cover/+server.ts` and its wiki,
 * `albums-and-permissions.md`, "Covers and OG"). Withholding the wide one from a private album
 * therefore protected nothing - the square of the same photo was already on the card - and left
 * the one card the owner asked for (2026-11-27: private albums show their preview, cover included)
 * pixelated.
 */
export function galleryWideCoverFor(origin: string, albumId: string): string {
  return `${origin}/api/albums/${albumId}/og-cover`;
}

/** The card MiGallery's `GET /api/albums/[id]/preview` answers: these four fields, nothing else. */
interface MiGalleryAlbumPreview {
  name?: string;
  date?: string | null;
  location?: string | null;
  visibility?: string;
  /** Set on a 404 only, by the route itself, when the ALBUM is unknown. */
  code?: string;
}

/** The `code` MiGallery's preview route puts on the 404 of an unknown album. */
const MIGALLERY_ALBUM_NOT_FOUND = 'album_not_found';

const galleryLogger = new Logger('LinkPreview');

/** Whether the absent key was already reported by this process (it cannot change while it lives). */
let galleryKeyMissingReported = false;

/**
 * Fetches a link-preview payload for a MiGallery album URL, for EVERY visibility, private included.
 *
 * Reads MiGallery's `GET /api/albums/[id]/preview` with `MIGALLERY_API_URL` / `MIGALLERY_API_KEY`
 * (a READ-scoped key): name, date, location and visibility, never the album's grant lists. It used
 * to read `/api/albums/[id]/info`, which also returns those lists and became the staff's in
 * MiGallery v2.23.1: the read key got `403 Write or Admin scope required`, this function returned
 * null without a word, and every album link fell to the HTML of a page that sends an anonymous
 * reader to sign in - the generic MiGallery card, measured on production 2026-11-27.
 *
 * ONE RULE, TWO KINDS OF THING: an image is public and needs no key, a metadata read does. The
 * cover URL is MiGallery's own public one (see {@link galleryWideCoverFor}), fetched like any other
 * preview image by the SSRF-guarded proxy, so the key never leaves this service.
 *
 * The URL is built from `targetUrl.origin`, never from `MIGALLERY_API_URL`: that variable may name
 * an internal address, and this string is handed to a browser and re-validated as an external URL
 * before anything fetches it.
 *
 * Returns `null` when the URL is not an album link, and when MiGallery did not give the card - then
 * the caller reads the page itself, which is a FALLBACK: every such branch logs at a level that
 * accuses, with the status, so a degraded card is never silent again.
 */
export async function fetchMiGalleryPreview(targetUrl: URL): Promise<{
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
} | null> {
  if (targetUrl.hostname !== GALLERY_HOST) return null;
  const match = GALLERY_ALBUM_RE.exec(targetUrl.pathname);
  if (!match) return null;

  const albumId = match[1];
  // Only an exact UUID (an Immich album id, which is all MiGallery ever names) is placed in the path
  // sent with the key: the loose path pattern above also matches `---` or `abc`, and no string a
  // message chose should decide which MiGallery route the key reaches.
  if (!GALLERY_ALBUM_ID_RE.test(albumId)) return null;
  // NEVER THE ALBUM ID IN A LOG LINE: for an unlisted album the id IS the bearer link, and a log
  // is read by people the link was never sent to. The host and the outcome say all a reader needs.
  const galleryBaseUrl = (process.env.MIGALLERY_API_URL || `https://${GALLERY_HOST}`).replace(
    /\/$/,
    ''
  );
  const apiKey = process.env.MIGALLERY_API_KEY || '';

  if (!apiKey) {
    // A state of the estate read from its environment, fixed for the life of the process: said
    // once, not once per link, or a key-less estate writes the same line for every album it meets.
    if (!galleryKeyMissingReported) {
      galleryKeyMissingReported = true;
      galleryLogger.warn(
        '[LINK_PREVIEW] MIGALLERY_API_KEY is not set: every MiGallery album card falls back to the page'
      );
    }
    return null;
  }

  let res: Response;
  let data: MiGalleryAlbumPreview;
  try {
    res = await fetch(`${galleryBaseUrl}/api/albums/${albumId}/preview`, {
      method: 'GET',
      headers: {
        'user-agent': 'CanariLinkPreview/1.0',
        accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(4000),
    });
    data = (await res.json().catch(() => ({}))) as MiGalleryAlbumPreview;
  } catch (error) {
    galleryLogger.warn(
      `[LINK_PREVIEW] MiGallery album preview unreachable, falling back to the page: ${String(errorCause(error) ?? error)}`
    );
    return null;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      galleryLogger.error(
        `[LINK_PREVIEW] MiGallery refused the album preview (${res.status}): MIGALLERY_API_KEY must hold the read scope - falling back to the page`
      );
    } else if (res.status === 404 && data.code === MIGALLERY_ALBUM_NOT_FOUND) {
      galleryLogger.warn('[LINK_PREVIEW] MiGallery knows no such album (/albums/{uuid}, 404)');
    } else if (res.status === 404) {
      // A 404 WITHOUT the route's own code is the 404 of a MiGallery that has no such route yet.
      galleryLogger.warn(
        '[LINK_PREVIEW] MiGallery has no preview route yet (404 on /api/albums/[id]/preview) - falling back to the page'
      );
    } else {
      galleryLogger.warn(
        `[LINK_PREVIEW] MiGallery album preview answered ${res.status} - falling back to the page`
      );
    }
    return null;
  }

  if (!data.name) {
    galleryLogger.warn(
      '[LINK_PREVIEW] MiGallery album preview carried no name - falling back to the page'
    );
    return null;
  }

  const descParts: string[] = [];
  if (data.date) {
    const d = new Date(data.date + 'T12:00:00');
    descParts.push(
      Number.isNaN(d.getTime())
        ? data.date
        : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    );
  }
  if (data.location) descParts.push(data.location);

  return {
    url: targetUrl.toString(),
    title: data.name.slice(0, 180),
    description: descParts.join(' · '),
    image: galleryWideCoverFor(targetUrl.origin, albumId),
    siteName: 'MiGallery',
  };
}

/** Returns true when `hostname` is one of the known YouTube domains (`youtube.com`, `youtu.be`, etc.). */
export function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com' || h === 'youtu.be'
  );
}

/**
 * Fetches a link-preview payload for a YouTube URL via the YouTube oEmbed API.
 * Returns `null` if `targetUrl` is not a YouTube URL, or if YouTube ANSWERS that it has nothing to
 * say about it. It does NOT swallow a transport failure - the doc comment used to claim it returned
 * null when "the API call fails", which was never true and hid the fact that this call carried no
 * deadline at all: no signal was passed, so the endpoint's budget did not reach the FIRST outbound
 * request it makes. The caller classifies what comes out of here like any other unreachable host.
 * The returned object has the same shape as `buildLinkPreviewPayload`.
 */
export async function fetchYouTubeOEmbed(
  targetUrl: URL,
  signal?: AbortSignal
): Promise<{
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
} | null> {
  if (!isYouTubeHost(targetUrl.hostname)) return null;

  const oembed = new URL('https://www.youtube.com/oembed');
  oembed.searchParams.set('url', targetUrl.toString());
  oembed.searchParams.set('format', 'json');

  const response = await fetch(oembed.toString(), {
    method: 'GET',
    signal,
    headers: {
      'user-agent': 'CanariLinkPreview/1.0',
      accept: 'application/json',
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };

  if (!data.title) return null;

  return {
    url: targetUrl.toString(),
    title: data.title.slice(0, 180),
    description: data.author_name ? `YouTube • ${data.author_name}` : 'YouTube',
    image: data.thumbnail_url ?? '',
    siteName: 'YouTube',
  };
}
