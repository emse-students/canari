import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

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
 * Shared undici dispatcher for outbound link-preview fetches. Pins every
 * connection to a validated, public-only resolved address via
 * {@link ssrfSafeLookup}. Pass it as the `dispatcher` of a global `fetch` call.
 */
export const ssrfSafeDispatcher = new Agent({
  connect: { lookup: ssrfSafeLookup },
});

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

/**
 * Extracts Open Graph / standard meta tags from `html` and returns a normalised
 * link-preview payload (url, title, description, image, siteName), each field
 * truncated to a safe display length.
 */
export function buildLinkPreviewPayload(html: string, targetUrl: URL) {
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
 * The cover image URL points to Canari's own `/api/mls/gallery-cover/:albumId`
 * proxy so the browser never needs the MiGallery API key directly.
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
  const frontendUrl = (process.env.FRONTEND_URL || 'https://canari-emse.fr').replace(/\/$/, '');

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
      image: `${frontendUrl}/api/mls/gallery-cover/${albumId}`,
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
 * Returns `null` if `targetUrl` is not a YouTube URL or the API call fails.
 * The returned object has the same shape as `buildLinkPreviewPayload`.
 */
export async function fetchYouTubeOEmbed(targetUrl: URL): Promise<{
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
