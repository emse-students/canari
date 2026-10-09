/** Validates checkout success/cancel URLs (HTTPS app origin or mobile deep link). */
export function resolveCheckoutCallbackUrl(
  candidate: string | undefined,
  fallback: string,
  frontendUrl: string
): string {
  const trimmed = candidate?.trim();
  if (trimmed && isAllowedCheckoutCallbackUrl(trimmed, frontendUrl)) {
    return trimmed;
  }
  return fallback;
}

export function isAllowedCheckoutCallbackUrl(url: string, frontendUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'fr.emse.canari:') {
      // `payment` is what clients emit now; `stripe` is what builds before 2026-10-09 registered and
      // still send (docs/wiki/legacy-compatibility.md), so both are accepted until it is removed.
      return (
        (u.host === 'payment' || u.host === 'stripe') &&
        (u.pathname === '/success' || u.pathname === '/cancel')
      );
    }
    const base = new URL(frontendUrl.endsWith('/') ? frontendUrl : `${frontendUrl}/`);
    if (u.origin !== base.origin) return false;
    const path = u.pathname.replace(/\/$/, '') || '/';
    return (
      path === '/forms/success' ||
      path === '/forms/cancel' ||
      path === '/posts' ||
      path === '/profile' ||
      path === '/shop'
    );
  } catch {
    return false;
  }
}
