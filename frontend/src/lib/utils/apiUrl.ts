/**
 * Returns the base URL for the core service (auth, users, payments).
 * Falls back to the current origin in the browser so relative paths work
 * when the app is served behind the same Nginx proxy.
 */
export function coreUrl(): string {
  const url = (import.meta as any).env?.VITE_CORE_URL as string | undefined;
  if (url?.trim()) return url.trim().replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
}

/**
 * Returns the base URL for the social service (posts, channels, associations).
 * Returns an empty string when VITE_SOCIAL_URL is not set so that relative
 * paths are used - Nginx routes /api/posts/* to the social service.
 */
export function socialUrl(): string {
  const url = (import.meta as any).env?.VITE_SOCIAL_URL as string | undefined;
  if (url?.trim()) return url.trim().replace(/\/$/, '');
  return '';
}

/**
 * Returns the base URL for the chat-gateway (WebSocket, presence, admin routes).
 * Must be an absolute URL in Tauri/mobile where `window.location.origin` is
 * `tauri://localhost` and does not reach the nginx proxy.
 */
export function gatewayUrl(): string {
  const url = (import.meta as any).env?.VITE_GATEWAY_URL as string | undefined;
  if (url?.trim()) return url.trim().replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
}

/**
 * Returns the base URL for the chat-delivery service (MLS HTTP API, push, history).
 * Must be an absolute URL in Tauri/mobile - see {@link gatewayUrl}.
 */
export function deliveryUrl(): string {
  const url = (import.meta as any).env?.VITE_DELIVERY_URL as string | undefined;
  if (url?.trim()) return url.trim().replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3010';
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
