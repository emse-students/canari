import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/**
 * Resolves a service's base URL for the runtime that is actually running.
 *
 * A real browser tab always shares its origin with the nginx that fronts it, whichever public
 * hostname served the page - `canari.emse.fr` and `canari-emse.fr` both proxy `/api/`, `/ws` and
 * `/media/` to the same backend, so the page's own origin is ALWAYS the right answer there and an
 * env-baked absolute URL is only ever correct for ONE of the two. `window.location.origin` is
 * therefore checked FIRST for a non-Tauri browser, ahead of the env var, not merely as its fallback.
 *
 * Tauri is the one runtime where that origin is useless - `tauri://localhost` / `http://tauri.
 * localhost` never reaches the proxy - so it is the one case that still needs the env var.
 */
function resolveServiceUrl(envValue: string | undefined, devFallback: string): string {
  if (typeof window !== 'undefined' && !isTauriRuntime()) return window.location.origin;
  const url = envValue?.trim();
  if (url) return url.replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : devFallback;
}

/**
 * Returns the base URL for the core service (auth, users, payments).
 * Same-origin in any real browser; falls back to `VITE_CORE_URL` only in Tauri/mobile.
 */
export function coreUrl(): string {
  return resolveServiceUrl((import.meta as any).env?.VITE_CORE_URL, 'http://localhost:3012');
}

/**
 * Returns the base URL for the social service (posts, channels, associations).
 * Same-origin in any real browser; falls back to `VITE_SOCIAL_URL` only in Tauri/mobile.
 */
export function socialUrl(): string {
  return resolveServiceUrl((import.meta as any).env?.VITE_SOCIAL_URL, '');
}

/**
 * Returns the base URL for the chat-gateway (WebSocket, presence, admin routes).
 * Same-origin in any real browser; must be an absolute `VITE_GATEWAY_URL` in Tauri/mobile where
 * `window.location.origin` is `tauri://localhost` and does not reach the nginx proxy.
 */
export function gatewayUrl(): string {
  return resolveServiceUrl((import.meta as any).env?.VITE_GATEWAY_URL, 'http://localhost:3000');
}

/**
 * Returns the base URL for the chat-delivery service (MLS HTTP API, push, history).
 * Same-origin in any real browser; must be an absolute `VITE_DELIVERY_URL` in Tauri/mobile - see
 * {@link gatewayUrl}.
 */
export function deliveryUrl(): string {
  return resolveServiceUrl((import.meta as any).env?.VITE_DELIVERY_URL, 'http://localhost:3010');
}

/**
 * Returns the base URL for the media service (uploads, `/api/media/…`).
 * Same-origin in any real browser; must be an absolute `VITE_MEDIA_URL` in Tauri/mobile.
 */
export function mediaUrl(): string {
  return resolveServiceUrl((import.meta as any).env?.VITE_MEDIA_URL, 'http://localhost:3011');
}

/**
 * Makes an app-relative API path fetchable from the runtime that is actually running.
 *
 * On the web the app and the API share an origin, so `/api/...` resolves by itself and nothing here
 * changes. In a Tauri build the page is served from `tauri://localhost` (iOS) or
 * `http://tauri.localhost` (Android) and that same path resolves against the SHELL, not the proxy -
 * the request leaves for an origin that serves no API and the image simply never arrives. Nothing
 * throws, nothing is logged, and a component with an error fallback shows the fallback forever,
 * which is exactly how this went unnoticed on the poster editor.
 *
 * Anything already carrying a scheme is returned untouched: an absolute URL, and equally a `data:`
 * or `blob:` URL, is already the answer.
 */
export function apiAssetUrl(pathOrUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
  if (!pathOrUrl.startsWith('/')) return pathOrUrl;
  return `${coreUrl()}${pathOrUrl}`;
}
