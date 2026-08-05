import { env } from '$env/dynamic/private';

/**
 * The one seam through which the SSR process talks to the services.
 *
 * Server-only: it reads `$env/dynamic/private`, so importing it from anything the client bundles
 * fails the build. Two callers today - the head injector (`serverSeo.ts`) and the sitemap
 * (`routes/sitemap.xml/+server.ts`) - and they must agree on the base URLs, the auth header and,
 * above all, on failing soft. Neither of them is the page; a service that is slow or down degrades
 * a preview or shortens a sitemap, and must never cost a navigation.
 */

/** Docker-network base URLs. Requests go direct, never back through nginx. */
export const SOCIAL_URL = (): string =>
  (env.SOCIAL_SERVICE_URL || 'http://social-service:3014').replace(/\/$/, '');
export const CORE_URL = (): string =>
  (env.CORE_SERVICE_URL || 'http://core-service:3012').replace(/\/$/, '');
export const DELIVERY_URL = (): string =>
  (env.DELIVERY_SERVICE_URL || 'http://chat-delivery-service:3010').replace(/\/$/, '');

/** Budget for one enrichment call. An unfurler gives up long before a user would. */
export const FETCH_TIMEOUT_MS = 1500;

/**
 * Headers proving a server-to-server call.
 *
 * Never `X-Internal-Token`: that HMAC is bound to a user id, so minting one here would be
 * impersonation rather than authentication.
 */
export function internalHeaders(): Record<string, string> {
  const secret = env.INTERNAL_SECRET?.trim();
  if (!secret) {
    console.log('[SEO] INTERNAL_SECRET is unset - invite and profile previews will stay generic');
    return {};
  }
  return { 'X-Internal-Secret': secret };
}

/** GETs JSON with a hard timeout. Returns null on any failure, logging the cause. */
export async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: abort.signal });
    if (!res.ok) {
      console.log(`[SEO] ${url} answered ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    // `fetch` reports every transport failure as a bare TypeError; the diagnosis is in `cause`.
    console.log(`[SEO] ${url} failed:`, (err as Error)?.message, (err as Error)?.cause ?? '');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
