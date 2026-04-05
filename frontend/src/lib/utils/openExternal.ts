/**
 * Open an external URL in the system browser on Tauri,
 * or navigate the current tab on the web.
 */
export async function openExternal(url: string): Promise<void> {
  if ((window as any).__TAURI_INTERNALS__) {
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
  if ((window as any).__TAURI_INTERNALS__) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.location.href = url;
  }
}
