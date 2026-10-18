/**
 * WHERE A GIF'S BYTES COME FROM: CANARI, NEVER THE GIF'S HOST.
 *
 * A GIF sent from the picker is a KLIPY CDN URL inside an end-to-end encrypted message. Every
 * reader's `<img>` used to fetch it from that CDN, telling KLIPY each reader's address, user agent
 * and the moment the message came into view - for every recipient, on every render that missed the
 * browser cache. The message still CARRIES that URL (an older client renders it as it always did);
 * this rewrite happens at render time only, at the four places that draw or read a GIF: the bubble
 * (`GifEmbed`), the quoted reply (`ReplyGifThumb`), the picker's grid (`GifGrid`) and a comment's
 * attach (`PostComments.handleGifSelected`).
 *
 * - KLIPY's CDN goes to the GIF relay, `GET /api/mls/gifs/media` (chat-delivery's
 *   `gif-media.controller.ts`: that host only, `image/gif`, 12 MiB, streamed, cached).
 * - ANY OTHER HOST (`isGifUrl` matches any `.gif` link, and tenor/giphy pages) goes to the
 *   link-preview image proxy, as a pasted image's preview already does: no reader's browser asks a
 *   third party for a GIF either way. That proxy's own limits apply (3 MB, `image/*`), so a larger
 *   foreign GIF fails to load and the bubble shows its link - a refusal by policy, decided
 *   2026-10-18, rather than a direct load that would leak the reader to an arbitrary host.
 *
 * Both return `''` while no ticket is held; every caller draws nothing until the ticket lands, and
 * re-renders then because reading the ticket is a reactive read.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */

import { deliveryUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { proxiedPreviewImageUrl } from '$lib/utils/previewImageProxy';
import { ensurePreviewTicket, gifMediaTicket } from '$lib/utils/previewTicket.svelte';

/** The one host the GIF relay serves - the same allowlist as the server's `KLIPY_CDN_HOST`. */
export const KLIPY_CDN_HOST = 'static.klipy.com';

/** Whether `url` is an https URL on KLIPY's CDN (the only kind the relay accepts). */
export function isKlipyCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === KLIPY_CDN_HOST && !u.port;
  } catch {
    return false;
  }
}

/**
 * The URL to draw or fetch a GIF from, given the URL the message (or the picker) carries.
 *
 * The fragment is NOT sent: it is cut from the relayed `url=` (a browser never sends one, and the
 * `#cn-size` must not make one GIF several cache entries) and put back on the END of the returned
 * URL, so the size the sender declared still reads off whatever URL a component holds.
 */
export function proxiedGifUrl(rawUrl: string): string {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (!isKlipyCdnUrl(rawUrl)) return proxiedPreviewImageUrl(rawUrl);

  const ticket = gifMediaTicket();
  if (!ticket) return '';

  const hashAt = rawUrl.indexOf('#');
  const content = hashAt < 0 ? rawUrl : rawUrl.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : rawUrl.slice(hashAt);
  return `${deliveryUrl()}/api/mls/gifs/media?url=${encodeURIComponent(content)}&t=${ticket}${fragment}`;
}

/**
 * A picked GIF's BYTES, as a `File` - for a comment, which encrypts and uploads them rather than
 * sending the link. Read through {@link proxiedGifUrl} like every GIF render, after making sure a
 * ticket is held (the picker can be opened and closed before one lands, and an empty URL would
 * fetch this page). Throws on no ticket, a transport failure or a non-2xx answer.
 */
export async function fetchGifFile(url: string): Promise<File> {
  await ensurePreviewTicket();
  const relayed = proxiedGifUrl(url);
  if (!relayed) throw new Error('no GIF relay ticket could be obtained');
  Log.d(
    'GifMedia',
    `reading a picked GIF's bytes via ${isKlipyCdnUrl(url) ? 'the GIF relay' : 'the preview proxy'}`
  );
  const res = await fetch(relayed);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  // Named after the GIF, never after the relay URL (whose last segment is `media?...`).
  const name = url.split('#')[0].split('/').pop()?.split('?')[0] || `gif-${Date.now()}.gif`;
  return new File([blob], name, { type: blob.type || 'image/gif' });
}
