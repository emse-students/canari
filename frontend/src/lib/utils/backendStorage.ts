/**
 * Client for the backend counterpart of `deviceStorage.ts` (WP-DEVICESTORAGE-1): reports what the
 * SERVER itself is using, distinct from the client's own local storage. Display-only - there is no
 * "clear" action here, unlike the media cache on-device, since none of these four numbers are
 * something an admin should be deleting from a UI button.
 */

import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';

export interface BackendStorageUsage {
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  postgresBytes: number | null;
  redisBytes: number | null;
  garageBytes: number | null;
  garageObjectCount: number | null;
}

/**
 * Fetches the backend storage breakdown from `chat-delivery-service`. Each field independently
 * measured server-side, so a `null` field means that ONE measurement failed (e.g. media-service
 * unreachable for the Garage figure), never that the whole request did - only a non-2xx response or
 * a network failure throws.
 */
export async function getBackendStorageUsage(): Promise<BackendStorageUsage> {
  const response = await apiFetch(`${deliveryUrl()}/api/mls/admin/storage`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
