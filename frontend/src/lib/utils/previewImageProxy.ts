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
 */

/** Base URL of chat-delivery, the service that owns the preview endpoints. */
function deliveryBase(): string {
  return import.meta.env.VITE_DELIVERY_URL?.trim() || window.location.origin;
}

/**
 * The proxied URL for `rawUrl`, or `rawUrl` itself when proxying it would be
 * pointless or wrong.
 *
 * Left alone: anything that is not http(s) - a data URI is already local, and
 * nothing else may reach an `<img src>` - and anything already served by us,
 * which includes the MiGallery cover proxy the preview payload points at.
 * Proxying our own origin would work and would simply cost a second hop.
 */
export function proxiedPreviewImageUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return rawUrl ?? '';

  const base = deliveryBase();
  try {
    const target = new URL(rawUrl);
    if (target.origin === new URL(base).origin || target.origin === window.location.origin) {
      return rawUrl;
    }
  } catch {
    return rawUrl;
  }

  return `${base}/api/mls/link-preview/image?url=${encodeURIComponent(rawUrl)}`;
}
