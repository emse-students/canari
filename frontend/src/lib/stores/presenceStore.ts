import { get, writable } from 'svelte/store';

export const presenceMap = writable<Record<string, boolean>>({});
const peerIdsToPoll = new Set<string>();
let pollInterval: any = null;

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
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
    const res = await fetch(`${baseUrl}/api/presence?users=${usersStr}`);
    if (res.ok) {
      const data = await res.json();
      presenceMap.update((prev) => ({ ...prev, ...data }));
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
