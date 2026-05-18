import { get, writable } from 'svelte/store';
import { apiFetch } from '$lib/utils/apiFetch';
import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';

/**
 * Svelte store mapping each watched user ID to a boolean indicating whether
 * that user is currently online. Updated every 10 seconds by the polling loop.
 */
export const presenceMap = writable<Record<string, boolean>>({});
const peerIdsToPoll = new Set<string>();
let _destroyInterval: (() => void) | null = null;

/** Returns the base URL for the chat gateway, falling back to the current origin. */
function getGatewayBase(): string {
  const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GATEWAY_URL;
  if (typeof env === 'string' && env.trim()) {
    return env.trim().replace(/\/$/, '');
  }
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * Adds the given user IDs to the polling watchlist and starts the polling loop
 * if it is not already running. The loop automatically pauses when the page is
 * hidden and resumes when visible.
 */
export function watchUsers(userIds: string[]) {
  userIds.forEach((id) => {
    if (id) peerIdsToPoll.add(id);
  });
  if (!_destroyInterval) {
    _destroyInterval = createPausableInterval(checkPresenceNow, 10_000);
  }
}

/** Returns `true` if the given user is currently marked as online in the local presence map. */
export function isUserOnline(userId: string): boolean {
  return get(presenceMap)[userId] || false;
}

/**
 * Immediately fetches presence status for all watched users from the gateway and
 * merges the result into `presenceMap`. Silently skips non-JSON or 401 responses.
 */
export async function checkPresenceNow() {
  if (peerIdsToPoll.size === 0) return;
  const usersStr = Array.from(peerIdsToPoll).join(',');
  try {
    const baseUrl = getGatewayBase();
    const res = await apiFetch(`${baseUrl}/api/presence?users=${usersStr}`);
    if (res.ok) {
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        console.warn('Presence endpoint returned non-JSON response, skipping update.');
        return;
      }
      const data = await res.json();
      presenceMap.update((prev) => ({ ...prev, ...data }));
      return;
    }
    if (res.status !== 401) {
      console.warn(`Presence request failed with status ${res.status}.`);
    }
  } catch (err) {
    console.error('Failed to fetch presence', err);
  }
}
