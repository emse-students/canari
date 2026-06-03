import { inAppPathFromHref, isPublicAppUrl } from '$lib/utils/publicAppUrl';
import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'webcal:']);

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

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
    if (url.protocol === 'fr.emse.canari:') return false;
    if (isPublicAppUrl(url.href, base)) return false;
    if (url.origin === new URL(base).origin) return false;
    return EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Intercept link clicks: Canari app URLs navigate in-app (web + Tauri); other http(s) links
 * open in the system browser on Tauri only.
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

  const rawHref = anchor.getAttribute('href') ?? '';
  const href =
    rawHref.startsWith('/') && !rawHref.startsWith('//') ? rawHref : anchor.href || rawHref;

  const inAppPath = inAppPathFromHref(href);
  if (inAppPath) {
    event.preventDefault();
    event.stopPropagation();
    void navigateInAppFromHref(href);
    return true;
  }

  // Public Canari URL without a mapped in-app route — do not swallow the click.
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

/** @deprecated Use {@link installAppLinkClickHandler}. */
export function installExternalLinkClickHandler(): void {
  installAppLinkClickHandler();
}

/** @deprecated Use {@link handleAppLinkClick}. */
export function handleExternalLinkClick(event: MouseEvent): boolean {
  return handleAppLinkClick(event);
}

/**
 * Open an external URL in the system browser on Tauri,
 * or in a new tab on the web.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Navigate to an external URL.
 * On Tauri, opens in system browser. On web, redirects the page.
 */
export async function navigateExternal(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.location.href = url;
  }
}
