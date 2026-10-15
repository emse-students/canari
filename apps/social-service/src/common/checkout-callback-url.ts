import { Logger } from '@nestjs/common';

const logger = new Logger('CheckoutCallback');

/**
 * Validates checkout success/cancel URLs (HTTPS app origin or mobile deep link).
 *
 * A URL the client SENT and this refuses falls back to the web return, which a phone cannot catch -
 * so the refusal is logged at warn, naming the scheme, host and path (never the query, which
 * carries session ids): a client sending one is a client to find, e.g. a build below 1.2.4 still
 * naming the retired `stripe` host.
 */
export function resolveCheckoutCallbackUrl(
  candidate: string | undefined,
  fallback: string,
  frontendUrl: string
): string {
  const trimmed = candidate?.trim();
  if (!trimmed) return fallback;
  if (isAllowedCheckoutCallbackUrl(trimmed, frontendUrl)) return trimmed;
  logger.warn(
    `[CHECKOUT] callback URL REFUSED, falling back to the web return: ${describeUrl(trimmed)}`
  );
  return fallback;
}

/** `scheme://host/path` of a URL for a log line, or a marker when it does not parse. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 120);
  } catch {
    return '<unparseable>';
  }
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
