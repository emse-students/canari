/**
 * WHERE A KLIPY GIF'S BYTES COME FROM: CANARI, NEVER KLIPY'S CDN.
 *
 * A GIF sent from the picker is a KLIPY CDN URL inside an end-to-end encrypted message. Every
 * reader's `<img>` used to fetch it from that CDN, telling KLIPY each reader's address, user agent
 * and the moment the message came into view - for every recipient, on every render that missed the
 * browser cache. The message still CARRIES that URL (an older client renders it as it always did);
 * this rewrite happens at render time only, at the four places that draw or read a GIF: the bubble
 * (`GifEmbed`), the quoted reply (`ReplyGifThumb`), the picker's grid (`GifGrid`) and a comment's
 * attach (`CommentComposer.handleGifSelected`).
 *
 * - KLIPY's CDN goes to the GIF relay, `GET /api/mls/gifs/media` (chat-delivery's
 *   `gif-media.controller.ts`: that host only, no query, `image/gif`, 12 MiB, streamed, cached).
 * - ANY OTHER HOST (`isGifUrl` matches any `.gif` link, and tenor/giphy pages) is LEFT ALONE and
 *   loads directly, as before (owner decision 2026-10-18: no regression for them). So a reader of
 *   a pasted giphy or tenor GIF still reaches that host - unmeasured, and the picker never sends
 *   one. Routing them later is one line here: return `proxiedPreviewImageUrl(rawUrl)` for them.
 *
 * A KLIPY URL answers `''` while no ticket is held; every caller draws nothing until the ticket
 * lands, and re-renders then because reading the ticket is a reactive read.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */

import { deliveryUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { ensurePreviewTicket, gifMediaTicket } from '$lib/utils/previewTicket.svelte';

/** The one host the GIF relay serves - the same allowlist as the server's `KLIPY_CDN_HOST`. */
export const KLIPY_CDN_HOST = 'static.klipy.com';

/**
 * Whether `url` is one the relay accepts: https on KLIPY's CDN, default port, no query (the
 * server's `parseKlipyCdnUrl` refuses any query, KLIPY's paths being content-addressed).
 */
export function isKlipyCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname.toLowerCase() === KLIPY_CDN_HOST &&
      !u.port &&
      !url.split('#')[0].includes('?')
    );
  } catch {
    return false;
  }
}

/**
 * The URL to draw or fetch a GIF from, given the URL the message (or the picker) carries: the
 * relay for KLIPY's CDN, the URL itself for anything else.
 *
 * The fragment is NOT relayed: it is cut from `url=` (a browser never sends one, and the `#cn-size`
 * must not make one GIF several cache entries) and put back on the END of the returned URL, so the
 * size the sender declared still reads off whatever URL a component holds.
 */
export function proxiedGifUrl(rawUrl: string): string {
  if (!isKlipyCdnUrl(rawUrl)) return rawUrl;

  const ticket = gifMediaTicket();
  if (!ticket) return '';

  const hashAt = rawUrl.indexOf('#');
  const content = hashAt < 0 ? rawUrl : rawUrl.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : rawUrl.slice(hashAt);
  return `${deliveryUrl()}/api/mls/gifs/media?url=${encodeURIComponent(content)}&t=${ticket}${fragment}`;
}

/** Why a picked GIF's bytes did not arrive - each kind has its own sentence on screen. */
export type GifRelayFailure = 'busy' | 'timeout' | 'too-large' | 'network' | 'rejected';

/** A GIF download that ended badly, classified at the throw (never by reading the message). */
export class GifRelayError extends Error {
  constructor(
    readonly failure: GifRelayFailure,
    detail: string
  ) {
    super(`GIF relay: ${failure} (${detail})`);
    this.name = 'GifRelayError';
  }
}

/** The relay's own ceiling (12 MiB): a body declared larger is refused before it is read. */
export const GIF_MAX_BYTES = 12 * 1024 * 1024;

/** How long a picked GIF may take to arrive before the reader is offered a retry. */
export const GIF_FETCH_TIMEOUT_MS = 25_000;

export interface FetchGifFileOptions {
  /** Cancels the download (the reader dismissed it). Never reported as a failure. */
  signal?: AbortSignal;
  /** Fraction received, 0..1, whenever the server declared a length. */
  onProgress?: (fraction: number) => void;
  timeoutMs?: number;
}

/**
 * A picked GIF's BYTES, as a `File` - for a comment, which encrypts and uploads them rather than
 * sending the link. Read through {@link proxiedGifUrl} like every GIF render, after making sure a
 * ticket is held (the picker can be opened and closed before one lands, and an empty URL would
 * fetch this page).
 *
 * The body is READ AS IT ARRIVES so the caller can show progress, under a deadline, and a failure is
 * a {@link GifRelayError} whose `failure` tells a saturated relay (503, worth asking again) from a
 * stall, an oversize GIF and a refusal. A caller's own abort rethrows as the `AbortError` it is.
 */
export async function fetchGifFile(url: string, options: FetchGifFileOptions = {}): Promise<File> {
  const { signal, onProgress, timeoutMs = GIF_FETCH_TIMEOUT_MS } = options;
  await ensurePreviewTicket();
  const source = proxiedGifUrl(url);
  if (!source) throw new GifRelayError('rejected', 'no relay ticket could be obtained');
  Log.d(
    'GifMedia',
    `reading a picked GIF's bytes ${isKlipyCdnUrl(url) ? 'through the GIF relay' : 'from its own host'}`
  );

  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    let res: Response;
    try {
      res = await fetch(source, { signal: combined });
    } catch (error) {
      throw classifyTransport(error, signal, deadline);
    }
    if (!res.ok) {
      throw new GifRelayError(res.status === 503 ? 'busy' : 'rejected', `HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > GIF_MAX_BYTES) throw new GifRelayError('too-large', `${declared} bytes`);

    const chunks: BlobPart[] = [];
    let received = 0;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (received > GIF_MAX_BYTES) {
            void reader.cancel();
            throw new GifRelayError('too-large', `over ${GIF_MAX_BYTES} bytes`);
          }
          if (declared > 0) onProgress?.(Math.min(1, received / declared));
        }
      } else {
        chunks.push(await res.blob());
      }
    } catch (error) {
      if (error instanceof GifRelayError) throw error;
      throw classifyTransport(error, signal, deadline);
    }
    onProgress?.(1);
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'image/gif' });
    // Named after the GIF, never after the relay URL (whose last segment is `media?...`).
    const name = url.split('#')[0].split('/').pop()?.split('?')[0] || `gif-${Date.now()}.gif`;
    return new File([blob], name, { type: blob.type || 'image/gif' });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      Log.d('GifMedia', `a picked GIF did not arrive: ${String(error)}`);
    }
    throw error;
  }
}

/** The caller's abort stays an abort, the deadline becomes `timeout`, anything else is the network. */
function classifyTransport(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal) {
  if (signal?.aborted)
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  if (deadline.aborted) return new GifRelayError('timeout', 'deadline reached');
  return new GifRelayError('network', String(error));
}
