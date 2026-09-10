/**
 * Routes a link preview's images through Canari rather than loading them from
 * the site they came from.
 *
 * A preview card is rendered inside an end-to-end encrypted conversation, and
 * an `<img>` pointed at a remote host tells that host who is reading and when:
 * the reader's IP, their user agent, and the moment the message came into view.
 * Encrypting the message and then fetching its illustration in clear gives a
 * good part of that back. The proxy fetches once, server-side, and caches, so
 * the site sees one request every few hours instead of one per reader per read.
 *
 * It is also the only way the payload's `image` and `icon` can be trusted at
 * all: both are built from someone else's markup, and the proxy is what checks
 * that the answer is actually an image before a browser is asked to decode it.
 *
 * Every proxied URL carries a short-lived ticket, because the same properties
 * that make the proxy useful made it usable by anybody: measured 2026-09-10,
 * it relayed a Google favicon to a caller with no session at all. A subresource
 * request carries no `Authorization` header, so the session is proven once by
 * an authenticated call and the ticket carries that proof into the `<img src>`
 * - see `previewTicket.svelte.ts` and its server half.
 */

import { deliveryUrl } from '$lib/utils/apiUrl';
import { previewTicket } from '$lib/utils/previewTicket.svelte';

/**
 * The proxied URL for `rawUrl`, or `rawUrl` itself when proxying it would be
 * pointless or wrong.
 *
 * Left alone: anything that is not http(s) - a data URI is already local, and
 * nothing else may reach an `<img src>` - and anything already served by us,
 * which includes the MiGallery cover proxy the preview payload points at.
 * Proxying our own origin would work and would simply cost a second hop.
 *
 * Returns `''` while no ticket is held, which every caller already treats as
 * "no image": the alternative is putting a URL in front of a browser that is
 * certain to answer 401, and a console full of them. Callers render again when
 * the ticket lands, because reading it is a reactive read.
 */
export function proxiedPreviewImageUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return rawUrl ?? '';

  const base = deliveryUrl();
  try {
    const target = new URL(rawUrl);
    if (target.origin === new URL(base).origin || target.origin === window.location.origin) {
      return rawUrl;
    }
  } catch {
    return rawUrl;
  }

  const ticket = previewTicket();
  if (!ticket) return '';

  return `${base}/api/mls/link-preview/image?url=${encodeURIComponent(rawUrl)}&t=${ticket}`;
}
