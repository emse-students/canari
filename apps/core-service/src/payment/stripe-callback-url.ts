/** Validates Stripe success/cancel URLs (HTTPS app origin or mobile deep link). */
export function resolveStripeCallbackUrl(
  candidate: string | undefined,
  fallback: string,
  frontendUrl: string,
): string {
  const trimmed = candidate?.trim();
  if (trimmed && isAllowedStripeCallbackUrl(trimmed, frontendUrl)) {
    return trimmed;
  }
  return fallback;
}

export function isAllowedStripeCallbackUrl(
  url: string,
  frontendUrl: string,
): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'fr.emse.canari:') {
      return (
        u.host === 'stripe' &&
        (u.pathname === '/success' || u.pathname === '/cancel')
      );
    }
    const base = new URL(
      frontendUrl.endsWith('/') ? frontendUrl : `${frontendUrl}/`,
    );
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
