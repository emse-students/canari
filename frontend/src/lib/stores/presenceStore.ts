import { get, writable } from 'svelte/store';
import { apiFetch } from '$lib/utils/apiFetch';
import { gatewayUrl } from '$lib/utils/apiUrl';
import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';

/**
 * Svelte store mapping each watched user ID to a boolean indicating whether
 * that user is currently online. Updated every 10 seconds by the polling loop.
 */
export const presenceMap = writable<Record<string, boolean>>({});
const peerIdsToPoll = new Set<string>();
let _destroyInterval: (() => void) | null = null;

/**
 * Adds the given user IDs to the polling watchlist and starts the polling loop
 * if it is not already running. The loop automatically pauses when the page is
 * hidden and resumes when visible.
 *
 * Call `unwatchUsers` with the same IDs when the component unmounts to prevent
 * the watched set from growing unbounded across navigations.
 */
export function watchUsers(userIds: string[]) {
  userIds.forEach((id) => {
    if (id) peerIdsToPoll.add(id);
  });
  if (!_destroyInterval) {
    _destroyInterval = createPausableInterval(checkPresenceNow, 10_000);
  }
}

/**
 * Removes the given user IDs from the polling watchlist. When the set becomes
 * empty the interval is stopped entirely (saves battery when no presence is needed).
 */
export function unwatchUsers(userIds: string[]) {
  userIds.forEach((id) => peerIdsToPoll.delete(id));
  if (peerIdsToPoll.size === 0 && _destroyInterval) {
    _destroyInterval();
    _destroyInterval = null;
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
    const baseUrl = gatewayUrl();
    const res = await apiFetch(`${baseUrl}/api/presence?users=${usersStr}`);
    if (res.ok) {
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        console.warn('Presence endpoint returned non-JSON response, skipping update.');
        return;
      }
      const data = await res.json();
      // Only replace the map object when at least one value actually changed,
      // preventing cascading re-renders on every poll when statuses are stable.
      presenceMap.update((prev) => {
        const hasChange = Object.keys(data).some((k) => prev[k] !== data[k]);
        return hasChange ? { ...prev, ...data } : prev;
      });
      return;
    }
    if (res.status !== 401) {
      console.warn(`Presence request failed with status ${res.status}.`);
    }
  } catch (err) {
    console.error('Failed to fetch presence', err);
  }
}
