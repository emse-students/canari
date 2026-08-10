import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';

/**
 * Client side of WP-SAFELINK-1: asks `chat-delivery-service`'s `mls/link-safety` endpoint
 * whether a URL is flagged by Google Safe Browsing, and gates navigation behind a confirmation
 * when it is.
 */

/**
 * Deduped per href for the page's lifetime - both `AppLink` and `LinkPreviewCard` may ask about
 * the same URL around the same time. The server's own cache (`mls/link-safety`) is what actually
 * decides freshness across page loads; this Map only avoids firing the request twice at once.
 */
const safetyCache = new Map<string, Promise<boolean>>();

/**
 * Answers "not flagged" for a lookup that could not be made, and FORGETS it.
 *
 * The distinction the cache must keep is between an answer and the absence of one. A verdict may
 * be reused; a failure may not, because caching it converts one network blip into "this URL is
 * never checked again" - for the whole life of the page, which on mobile is days. The server keeps
 * the same distinction with a short `FAILURE_TTL_MS`, and a client cache that outlives it would
 * silently defeat it.
 */
function failOpen(href: string, why: string): boolean {
  safetyCache.delete(href);
  Log.d('checkLinkSafety', `lookup failed for ${href.slice(0, 60)} (${why}) - failing open`);
  return false;
}

/** True if `href` is flagged unsafe. Fails open (returns false) on any network or server error -
 * a safety check that cannot answer must never block a link, only skip the warning. */
export function checkLinkSafety(href: string): Promise<boolean> {
  const cached = safetyCache.get(href);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const baseUrl = import.meta.env.VITE_DELIVERY_URL?.trim() || window.location.origin;
      const endpoint = `${baseUrl}/api/mls/link-safety?url=${encodeURIComponent(href)}`;
      const res = await fetch(endpoint);
      if (!res.ok) return failOpen(href, `status ${res.status}`);
      const data = (await res.json()) as { unsafe?: boolean };
      return data.unsafe === true;
    } catch (e) {
      return failOpen(href, String(e).slice(0, 80));
    }
  })();

  safetyCache.set(href, promise);
  return promise;
}

/**
 * Resolves to `true` when it is fine to proceed with navigating to `href` - either the link is
 * not flagged, or the user confirmed anyway. Only ever prompts once the check comes back
 * positive: the warning belongs at the point of navigation intent, not decorating every link.
 */
export async function confirmUnsafeLinkIfNeeded(href: string): Promise<boolean> {
  const unsafe = await checkLinkSafety(href);
  if (!unsafe) return true;

  const { showConfirm } = await import('$lib/stores/confirm.svelte');
  return showConfirm(m.link_safety_warning_message(), {
    confirmLabel: m.link_safety_continue_button(),
    danger: true,
  });
}
