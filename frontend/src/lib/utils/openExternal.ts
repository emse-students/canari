import { inAppPathFromHref, isPublicAppUrl } from '$lib/utils/publicAppUrl';
import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
import { confirmUnsafeLinkIfNeeded } from '$lib/utils/checkLinkSafety';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { handlePlaceLinkClick } from '$lib/navigation/scrollToTop';

export { isTauriRuntime };

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'webcal:']);

/**
 * Marks an anchor whose click `openEcosystemSite` owns (the app launcher). {@link handleAppLinkClick}
 * leaves such an anchor to its own `onclick`: otherwise, on the native shells, this capture-phase
 * handler would open the bare address before the sign-in handoff could be minted. Declared here,
 * not beside the opener, so this module imports nothing of the authenticated fetch.
 */
export const ECOSYSTEM_SITE_ATTRIBUTE = 'data-ecosystem-site';

/** True when the href should leave the WebView and open in the OS browser / default app. */
export function shouldOpenExternalHref(
  href: string,
  base: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return false;
  if (trimmed.toLowerCase().startsWith('javascript:')) return false;

  try {
    const url = new URL(trimmed, base);
    if (url.protocol === MOBILE_APP_PROTOCOL) return false;
    if (isPublicAppUrl(url.href, base)) return false;
    if (url.origin === new URL(base).origin) return false;
    return EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Intercept link clicks: Canari app URLs navigate in-app (web + Tauri); other http(s) links
 * open in the system browser on Tauri only. A re-tap of the open place's link (a link carrying
 * `PLACE_LINK_ATTRIBUTE`) scrolls that page to its top instead of navigating: this listener runs
 * first and stops the click, so it is the ONE place that decision can be made.
 * Returns true when default navigation was cancelled.
 */
export function handleAppLinkClick(event: MouseEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (anchor.hasAttribute(ECOSYSTEM_SITE_ATTRIBUTE)) return false;

  const rawHref = anchor.getAttribute('href') ?? '';
  const href =
    rawHref.startsWith('/') && !rawHref.startsWith('//') ? rawHref : anchor.href || rawHref;

  if (handlePlaceLinkClick(anchor, window.location.pathname)) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  const inAppPath = inAppPathFromHref(href);
  if (inAppPath) {
    event.preventDefault();
    event.stopPropagation();
    void navigateInAppFromHref(href);
    return true;
  }

  // Public Canari URL without a mapped in-app route - do not swallow the click.
  if (isPublicAppUrl(href)) return false;

  if (!isTauriRuntime() || !shouldOpenExternalHref(href)) return false;

  event.preventDefault();
  event.stopPropagation();
  void openExternal(href);
  return true;
}

/** Capture-phase listener for in-app Canari links (all platforms) and external links (Tauri). */
export function installAppLinkClickHandler(): void {
  document.addEventListener('click', handleAppLinkClick, true);
}

/**
 * Open an external URL in the system browser on Tauri, or in a new tab on the web.
 *
 * This is the ONE place that actually opens an arbitrary (possibly attacker-supplied) URL, on
 * every platform - the document-level capture listener below (`handleAppLinkClick`) and every
 * link-rendering component (`AppLink`, `LinkPreviewCard`, the conversation's shared-links tab)
 * all funnel here rather than opening a URL directly, specifically so the Safe Browsing gate
 * (WP-SAFELINK-1) cannot be bypassed by a call site that forgets it. It WAS bypassed this way:
 * `AppLink`/`LinkPreviewCard` gated their own `onclick`, but on Tauri that handler never ran -
 * the capture-phase listener below already intercepted the click and called this function
 * directly. Gating here instead covers every current and future caller uniformly.
 */
export async function openExternal(url: string): Promise<void> {
  const proceed = await confirmUnsafeLinkIfNeeded(url);
  if (!proceed) return;

  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Navigate to an external URL. On Tauri, opens in system browser. On web, redirects the page.
 *
 * Deliberately NOT safety-checked, unlike {@link openExternal}: every caller passes a URL our
 * own backend generated (a Stripe/Lydia checkout, a MiGallery/associations redirect), never a
 * URL taken from message or post content - there is nothing here for Safe Browsing to catch,
 * and prompting a user before their own payment checkout would be a false alarm every time.
 */
export async function navigateExternal(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.location.href = url;
  }
}
