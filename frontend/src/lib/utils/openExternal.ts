import { isPublicAppUrl } from '$lib/utils/publicAppUrl';

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
 * Intercept a click on an external link (Tauri only).
 * Returns true when the default navigation was cancelled and the URL was opened externally.
 */
export function handleExternalLinkClick(event: MouseEvent): boolean {
  if (!isTauriRuntime() || event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;

  const href = anchor.href || anchor.getAttribute('href') || '';
  if (isPublicAppUrl(href)) {
    event.preventDefault();
    event.stopPropagation();
    void import('$lib/utils/appLinkNavigation').then((m) => m.navigateInAppFromPublicUrl(href));
    return true;
  }
  if (!shouldOpenExternalHref(href)) return false;

  event.preventDefault();
  event.stopPropagation();
  void openExternal(href);
  return true;
}

/** Capture-phase listener so links open externally before in-app handlers run. */
export function installExternalLinkClickHandler(): void {
  if (!isTauriRuntime()) return;
  document.addEventListener('click', handleExternalLinkClick, true);
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
