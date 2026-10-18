import { Transform, type TransformCallback } from 'node:stream';
import type { Response as ExpressResponse } from 'express';

/**
 * THE GIF RELAY'S POLICY: WHAT `GET mls/gifs/media` MAY FETCH, HOW MUCH, AND WHAT IT KEEPS.
 *
 * A GIF sent from the picker is a KLIPY CDN URL inside an end-to-end encrypted message, and every
 * reader's `<img>` used to fetch it from that CDN - telling KLIPY each reader's address, user agent
 * and the moment the message came into view. The relay fetches it here instead, so KLIPY sees this
 * server. The link-preview image proxy already did this for any image; it could not carry GIFs as
 * it was (a 3 MB ceiling, a small-image cache, a whole body buffered), so the GIF route has its own
 * numbers and shares the guard, the ticket and the response headers with it.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */

/**
 * The ONE host the relay fetches from: KLIPY's CDN. An allowlist rather than the SSRF guard alone,
 * because the guard says only "public address" - without this the route would be a 12 MiB relay
 * for any image on the internet. A GIF from any other host is not relayed at all: the client loads
 * it directly, as before (`frontend/src/lib/utils/gifMediaProxy.ts`).
 */
export const KLIPY_CDN_HOST = 'static.klipy.com';

/**
 * The largest GIF relayed, in bytes. MEASURED 2026-10-18 over 144 GIFs (trending plus searches):
 * the `sm` rendition (the picker grid) peaked at 2.9 MB; the `md` rendition (what is sent) had a
 * median of 1.1 MB, a p90 of 4.4 MB and a maximum of 11.7 MB, one in five over 3 MiB - the share
 * the preview proxy's 3 MB ceiling would have broken. 12 MiB covers the largest seen.
 */
export const GIF_MEDIA_MAX_BYTES = 12 * 1024 * 1024;

/**
 * The largest GIF kept in the byte cache. Above it the GIF is still relayed, streamed, but not
 * retained: holding the whole of one costs its full size in memory WHILE it streams, so this is
 * also what bounds a request's memory. 4 MiB keeps nearly nine in ten `md` renditions (p90 4.4 MB).
 */
export const GIF_MEDIA_CACHE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;

/** What the byte cache holds at most, all entries together. */
export const GIF_MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Distinct GIFs on their way from KLIPY at once, at most. Each may hold up to
 * {@link GIF_MEDIA_CACHE_ENTRY_MAX_BYTES} while it streams, so this bounds the relay's in-flight
 * memory at 64 MiB beside the cache's 64 MiB. Identical requests wait on the one fetch and are not
 * counted (single-flight); beyond the cap a request is refused `busy` (503).
 */
export const GIF_MEDIA_MAX_IN_FLIGHT = 16;

/**
 * Relay requests one visitor address may make per minute. Sized for GIFs, not the service's
 * 10/min default: a picker page is 24 thumbnails and a conversation scrolled back can hold dozens,
 * and the address nginx forwards may be a whole campus behind one NAT - so generous, against a
 * scripted loop rather than a reader.
 */
export const GIF_MEDIA_LIMIT_PER_MINUTE = 600;

/**
 * How long a cached GIF is reused, and what the reader's browser is told. KLIPY's URLs are
 * content-addressed (a new GIF is a new path) and its CDN itself says `max-age=86400`.
 */
export const GIF_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

/** Every reason the relay refuses, one per distinct log line and status. */
export type GifMediaRefusal =
  | 'missing-url'
  | 'invalid-url'
  | 'not-https'
  | 'host-not-allowed'
  | 'credentials'
  | 'non-default-port'
  | 'query-not-allowed'
  | 'busy'
  | 'blocked-address'
  | 'redirected'
  | 'upstream-not-found'
  | 'upstream-status'
  | 'not-gif'
  | 'empty-body'
  | 'too-large';

/**
 * The status each refusal answers. 4xx where the request named something the relay will not
 * serve, 502 where KLIPY answered something the relay cannot pass on, 404 passed through so a
 * deleted GIF reads as one.
 */
export const GIF_MEDIA_REFUSAL_STATUS: Record<GifMediaRefusal, number> = {
  'missing-url': 400,
  'invalid-url': 400,
  'not-https': 400,
  'host-not-allowed': 400,
  credentials: 400,
  'non-default-port': 400,
  'query-not-allowed': 400,
  // Too many distinct GIFs on their way from KLIPY at once: ours, transient, retried by the next
  // render - never cached by anybody.
  busy: 503,
  'blocked-address': 400,
  redirected: 502,
  'upstream-not-found': 404,
  'upstream-status': 502,
  'not-gif': 415,
  'empty-body': 502,
  'too-large': 413,
};

/**
 * The relay refused, for a reason it names. A TYPE, so the controller maps it to a status and a log
 * line without reading prose.
 */
export class GifMediaRefusedError extends Error {
  constructor(
    readonly reason: GifMediaRefusal,
    readonly detail = ''
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'GifMediaRefusedError';
  }

  /** The HTTP status this refusal answers. */
  get status(): number {
    return GIF_MEDIA_REFUSAL_STATUS[this.reason];
  }
}

/**
 * Parses the caller's URL and holds it to the allowlist: one string, https, `static.klipy.com`, no
 * credentials, no explicit port. The fragment is dropped - a browser never sends one, and the
 * `#cn-size` a sender writes must not split one GIF into several cache entries. Throws
 * {@link GifMediaRefusedError}. The SSRF guard (`assertSafeExternalUrl`) still runs after this: the
 * allowlist decides WHICH host, the guard that its addresses are public.
 */
export function parseKlipyCdnUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0) throw new GifMediaRefusedError('missing-url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GifMediaRefusedError('invalid-url');
  }
  if (url.protocol !== 'https:') throw new GifMediaRefusedError('not-https', url.protocol);
  if (url.hostname.toLowerCase() !== KLIPY_CDN_HOST) {
    throw new GifMediaRefusedError('host-not-allowed', url.hostname);
  }
  if (url.username || url.password) throw new GifMediaRefusedError('credentials');
  if (url.port) throw new GifMediaRefusedError('non-default-port', url.port);
  // KLIPY's paths are content-addressed and carry no query. Any query - `?x=1`, `?x=2`, ... - would
  // be a new cache key per request, so the cache and the single-flight would be defeated by a
  // counter in the URL: refused, not stripped, since a client of ours never sends one.
  // `raw` is read too: a bare trailing `?` parses to an empty `search` but keeps a distinct `href`.
  if (url.search || raw.split('#')[0].includes('?'))
    throw new GifMediaRefusedError('query-not-allowed');
  url.hash = '';
  return url;
}

/** Whether a `content-type` header is a GIF - parameters and case ignored. */
export function isGifContentType(header: string | null): boolean {
  return (header ?? '').split(';')[0].trim().toLowerCase() === 'image/gif';
}

/**
 * The bytes between KLIPY and the reader, counted. It refuses ({@link GifMediaRefusedError}
 * `too-large`) the chunk that crosses `maxBytes` - the declared length was already checked, and this
 * is for a missing or lying one - and keeps a copy for the cache only while the total stays under
 * `keepUpTo`, dropping it the moment it does not: the copy is the only buffering the relay does.
 */
export class GifByteCounter extends Transform {
  received = 0;
  private kept: Buffer[] | null = [];

  constructor(
    private readonly maxBytes: number,
    private readonly keepUpTo: number
  ) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.received += chunk.length;
    if (this.received > this.maxBytes) {
      callback(new GifMediaRefusedError('too-large', `${this.received} bytes streamed`));
      return;
    }
    if (this.kept) {
      if (this.received <= this.keepUpTo) this.kept.push(chunk);
      else this.kept = null;
    }
    callback(null, chunk);
  }

  /** The whole body, when it was small enough to keep; `null` otherwise. */
  body(): Buffer | null {
    return this.kept ? Buffer.concat(this.kept) : null;
  }
}

/**
 * The headers of a relayed image, for both relays (link previews and GIFs): its type, its length
 * when known, how long the browser may keep it, and `nosniff` - the bytes come from a third party
 * and are served from our own origin, so a browser must not read them as anything but the image
 * type declared.
 */
export function writeRelayedImageHeaders(
  res: ExpressResponse,
  image: { contentType: string; length: number | null; cacheControl: string }
): void {
  res.setHeader('Content-Type', image.contentType);
  if (image.length !== null) res.setHeader('Content-Length', image.length);
  res.setHeader('Cache-Control', image.cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
