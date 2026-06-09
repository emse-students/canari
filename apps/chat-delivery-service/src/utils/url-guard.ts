import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Returns true if `ip` is a loopback, link-local, or RFC-1918 private address
 * (IPv4 or IPv6). Used to block server-side requests from being redirected to
 * internal infrastructure (SSRF prevention).
 */
export function isPrivateIpAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part)))
    return true;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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

  const hostname = parsed.hostname.toLowerCase();
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

  for (const entry of resolved) {
    if (isPrivateIpAddress(entry.address)) {
      throw new BadRequestException('Private network URLs are not allowed');
    }
  }

  return parsed;
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
  return normalized.replace(
    /&(amp|quot|apos);|&#39;|&#x27;/gi,
    (full, named?: string) => {
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
    },
  );
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
  const title =
    extractMetaContent(html, 'og:title') ||
    extractTitle(html) ||
    targetUrl.hostname;
  const description =
    extractMetaContent(html, 'og:description') ||
    extractMetaContent(html, 'description') ||
    '';
  const siteName =
    extractMetaContent(html, 'og:site_name') || targetUrl.hostname;

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
 * Fetches a link-preview payload for a MiGallery album URL via the og-preview API.
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
  const previewApiUrl = `https://${GALLERY_HOST}/api/albums/${albumId}/og-preview`;

  try {
    const res = await fetch(previewApiUrl, {
      method: 'GET',
      headers: {
        'user-agent': 'CanariLinkPreview/1.0',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      name?: string;
      date?: string | null;
      location?: string | null;
      coverUrl?: string | null;
    };

    if (!data.name) return null;

    const descParts: string[] = [];
    if (data.date) {
      try {
        const d = new Date(data.date + 'T12:00:00');
        descParts.push(
          d.toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
        );
      } catch {
        descParts.push(data.date);
      }
    }
    if (data.location) descParts.push(data.location);

    return {
      url: targetUrl.toString(),
      title: data.name.slice(0, 180),
      description: descParts.join(' · '),
      image: data.coverUrl ?? '',
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
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    h === 'youtu.be'
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
