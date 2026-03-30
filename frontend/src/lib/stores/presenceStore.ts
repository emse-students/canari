import { get, writable } from 'svelte/store';
import { apiFetch } from '$lib/utils/apiFetch';

export const presenceMap = writable<Record<string, boolean>>({});
const peerIdsToPoll = new Set<string>();
let pollInterval: any = null;

function getGatewayBase(): string {
  const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GATEWAY_URL;
  if (typeof env === 'string' && env.trim()) {
    return env.trim().replace(/\/$/, '');
  }
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export function watchUsers(userIds: string[]) {
  userIds.forEach((id) => {
    if (id) peerIdsToPoll.add(id);
  });
  startPolling();
}

export function isUserOnline(userId: string): boolean {
  return get(presenceMap)[userId] || false;
}

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

export function startPolling() {
  if (pollInterval) return;
  checkPresenceNow();
  pollInterval = setInterval(checkPresenceNow, 10000); // 10 secondes
}

export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
