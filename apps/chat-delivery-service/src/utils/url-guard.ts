import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
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

  const resolved = await lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new BadRequestException('Host cannot be resolved');
  }
  assertPublicAddresses(resolved);

  return parsed;
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
    readonly reason: unknown
  ) {
    super(`${host} unreachable: ${String(errorCause(reason) ?? reason)}`);
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
 * Decodes a safe subset of HTML entities (`&amp;`, `&quot;`, `&apos;`, `&#39;`, `&#x27;`)
 * found in link-preview metadata fields. Intentionally excludes `&lt;` and `&gt;` to
 * prevent double-unescape attacks (CWE-116) where `&amp;lt;` would otherwise become `<`.
 */
export function decodeHtmlEntity(value: unknown): string {
  const normalized = typeof value === 'string' ? value : '';
  // Plain-text link preview fields: decode a small set once. Omit &lt; / &gt; so one pass cannot
  // turn &amp;lt;… into angle brackets (CWE-116 / double-unescape patterns).
  return normalized.replace(/&(amp|quot|apos);|&#39;|&#x27;/gi, (full, named?: string) => {
    if (named !== undefined)
      switch (named.toLowerCase()) {
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return full;
      }
    const low = full.toLowerCase();
    if (low === '&#39;' || low === '&#x27;') return "'";
    return full;
  });
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
  return match ? decodeHtmlEntity(match[1].trim()) : null;
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
 */
export function extractIconUrl(html: string, targetUrl: URL): string {
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
      const resolved = new URL(href, targetUrl);
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

  return best?.href ?? new URL('/favicon.ico', targetUrl.origin).toString();
}

/**
 * Extracts Open Graph / standard meta tags from `html` and returns a normalised
 * link-preview payload (url, title, description, image, siteName, icon), each
 * field truncated to a safe display length.
 */
export function buildLinkPreviewPayload(html: string, targetUrl: URL): LinkPreviewPayload {
  const title = extractMetaContent(html, 'og:title') || extractTitle(html) || targetUrl.hostname;
  const description =
    extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description') || '';
  const siteName = extractMetaContent(html, 'og:site_name') || targetUrl.hostname;

  const rawImage = extractMetaContent(html, 'og:image');
  let image = '';
  if (rawImage) {
    try {
      image = new URL(rawImage, targetUrl).toString();
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
    icon: extractIconUrl(html, targetUrl),
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
 */
export function extractOEmbedEndpoint(html: string, targetUrl: URL): string | null {
  for (const attrs of extractLinkTags(html)) {
    if (attrs.rel?.toLowerCase() !== 'alternate') continue;

    const type = attrs.type?.toLowerCase() ?? '';
    if (type !== 'application/json+oembed' && type !== 'text/json+oembed') continue;
    if (!attrs.href) continue;

    try {
      const resolved = new URL(attrs.href, targetUrl);
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
 * Follows a discovered oEmbed endpoint and returns the fields we can use.
 *
 * Goes through the same SSRF guard as the page fetch: the endpoint is declared
 * by the page, so it is exactly as attacker-controlled as the URL that was
 * pasted. Never throws - a preview that already has Open Graph data must not be
 * lost because the optional enrichment failed.
 */
export async function fetchOEmbedData(
  endpoint: string,
  signal?: AbortSignal
): Promise<OEmbedData | null> {
  try {
    const safeUrl = await assertSafeExternalUrl(endpoint);
    const response = await ssrfSafeFetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': 'CanariLinkPreview/1.0',
        accept: 'application/json',
      },
    });

    if (!response.ok) return null;
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('json')) return null;

    const raw = (await response.text()).slice(0, 100_000);
    const data = JSON.parse(raw) as {
      title?: unknown;
      author_name?: unknown;
      thumbnail_url?: unknown;
      provider_name?: unknown;
    };

    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;

    return {
      title: asString(data.title),
      authorName: asString(data.author_name),
      thumbnailUrl: asString(data.thumbnail_url),
      providerName: asString(data.provider_name),
    };
  } catch {
    return null;
  }
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
 */
export function mergeOEmbedIntoPayload(
  payload: LinkPreviewPayload,
  oembed: OEmbedData | null,
  targetUrl: URL
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
      const resolved = new URL(oembed.thumbnailUrl, targetUrl);
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
const GALLERY_ALBUM_RE = /^\/albums\/([0-9a-f-]+)\/?$/i;

/**
 * Fetches a link-preview payload for a MiGallery album URL.
 *
 * Uses `MIGALLERY_API_URL` / `MIGALLERY_API_KEY` from the environment to call the
 * authenticated `/api/albums/[id]/info` endpoint - works for all visibility
 * levels (unlisted, authenticated, private).
 *
 * ONE RULE, TWO KINDS OF THING: an image is public and needs no key, a metadata
 * read does. MiGallery serves every album's cover unauthenticated whatever its
 * visibility - an external site embeds one from an `<img>`, which carries no
 * key - so the image URL here is MiGallery's own public one, fetched like any
 * other preview image by the SSRF-guarded proxy. Only this call holds the key,
 * because `/info` is the one thing that stays gated.
 *
 * The URL is built from `targetUrl.origin`, never from `MIGALLERY_API_URL`: that
 * variable may name an internal address, and this string is handed to a browser
 * and re-validated as an external URL before anything fetches it.
 *
 * Returns `null` when the URL is not a recognised album link or the API call fails.
 * The returned object has the same shape as `buildLinkPreviewPayload`.
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
  const galleryBaseUrl = (process.env.MIGALLERY_API_URL || `https://${GALLERY_HOST}`).replace(
    /\/$/,
    ''
  );
  const apiKey = process.env.MIGALLERY_API_KEY || '';

  if (!apiKey) return null;

  try {
    const res = await fetch(`${galleryBaseUrl}/api/albums/${albumId}/info`, {
      method: 'GET',
      headers: {
        'user-agent': 'CanariLinkPreview/1.0',
        accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      album?: { name?: string; date?: string | null; location?: string | null };
    };

    const album = data.album;
    if (!album?.name) return null;

    const descParts: string[] = [];
    if (album.date) {
      try {
        const d = new Date(album.date + 'T12:00:00');
        descParts.push(
          d.toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        );
      } catch {
        descParts.push(album.date);
      }
    }
    if (album.location) descParts.push(album.location);

    return {
      url: targetUrl.toString(),
      title: album.name.slice(0, 180),
      description: descParts.join(' · '),
      image: `${targetUrl.origin}/api/albums/${albumId}/og-cover`,
      siteName: 'MiGallery',
    };
  } catch {
    return null;
  }
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
