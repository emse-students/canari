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
      // `payment` is the only checkout return host: `stripe` went with the builds below 1.2.4.
      return u.host === 'payment' && (u.pathname === '/success' || u.pathname === '/cancel');
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
