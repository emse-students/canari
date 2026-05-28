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
