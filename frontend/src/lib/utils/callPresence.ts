import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';
import { showToast } from '$lib/stores/toast.svelte';

/** Whether another device of the same user is currently in a call. */
export interface SiblingCallStatus {
  active: boolean;
  deviceId?: string;
  callId?: string;
  groupId?: string;
}

let lastWarnedSiblingDevice: string | null = null;

/**
 * Fetches whether a sibling device of the same account is in an active call.
 */
export async function fetchSiblingCallStatus(deviceId: string): Promise<SiblingCallStatus> {
  const { historyUrl } = resolveMlsPublicUrls();
  const url = new URL('/api/calls/sibling-status', historyUrl);
  url.searchParams.set('deviceId', deviceId);

  const res = await apiFetch(url.toString(), { method: 'GET', credentials: 'include' });
  if (!res.ok) return { active: false };
  return (await res.json()) as SiblingCallStatus;
}

/**
 * Updates Redis-backed call presence for this device (best-effort).
 */
export async function publishCallPresence(params: {
  deviceId: string;
  active: boolean;
  callId?: string;
  groupId?: string;
}): Promise<void> {
  const { historyUrl } = resolveMlsPublicUrls();
  const url = new URL('/api/calls/presence', historyUrl);
  await apiFetch(url.toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

/**
 * Shows a toast when another device is already in a call.
 * Dedupes by sibling device id until the remote call ends.
 */
export async function warnIfSiblingDeviceInCall(deviceId: string): Promise<boolean> {
  if (!deviceId?.trim()) return false;

  try {
    const status = await fetchSiblingCallStatus(deviceId);
    if (!status.active) {
      lastWarnedSiblingDevice = null;
      return false;
    }

    const siblingKey = status.deviceId ?? 'unknown';
    if (lastWarnedSiblingDevice === siblingKey) return true;

    lastWarnedSiblingDevice = siblingKey;
    showToast('Un autre appareil est déjà en appel.', 'info');
    return true;
  } catch {
    return false;
  }
}

/** Clears the dedupe guard (e.g. on logout). */
export function resetSiblingCallWarning(): void {
  lastWarnedSiblingDevice = null;
}
