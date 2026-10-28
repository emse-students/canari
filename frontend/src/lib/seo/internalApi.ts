import {
  CORE_SERVICE_URL,
  DELIVERY_SERVICE_URL,
  INTERNAL_SECRET,
  SOCIAL_SERVICE_URL,
} from '$app/env/private';
// The fetchers live in `upstream.ts`, which reads no environment and so can be unit-tested; they
// are re-exported so every caller keeps one door.
export { FETCH_TIMEOUT_MS, fetchJson, fetchJsonOrThrow } from '$lib/seo/upstream';

/**
 * The one seam through which the SSR process talks to the services.
 *
 * Server-only: it reads `$app/env/private`, so importing it from anything the client bundles
 * fails the build. Two callers today - the head injector (`serverSeo.ts`) and the sitemap
 * (`routes/sitemap.xml/+server.ts`) - and they must agree on the base URLs, the auth header and,
 * above all, on failing soft. Neither of them is the page; a service that is slow or down degrades
 * a preview or shortens a sitemap, and must never cost a navigation.
 */

/** Docker-network base URLs. Requests go direct, never back through nginx. */
export const SOCIAL_URL = (): string =>
  (SOCIAL_SERVICE_URL || 'http://social-service:3014').replace(/\/$/, '');
export const CORE_URL = (): string =>
  (CORE_SERVICE_URL || 'http://core-service:3012').replace(/\/$/, '');
export const DELIVERY_URL = (): string =>
  (DELIVERY_SERVICE_URL || 'http://chat-delivery-service:3010').replace(/\/$/, '');

/**
 * Headers proving a server-to-server call.
 *
 * Never `X-Internal-Token`: that HMAC is bound to a user id, so minting one here would be
 * impersonation rather than authentication.
 */
export function internalHeaders(): Record<string, string> {
  const secret = INTERNAL_SECRET?.trim();
  if (!secret) {
    console.log('[SEO] INTERNAL_SECRET is unset - invite and profile previews will stay generic');
    return {};
  }
  return { 'X-Internal-Secret': secret };
}
