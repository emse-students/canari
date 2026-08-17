/**
 * WP-DEVICESTORAGE-1: measures and manages how much of the device Canari is using.
 *
 * Two genuinely different measurement paths, not a false uniform abstraction over them:
 * - The media/logo Cache Storage buckets are measured and cleared the SAME way on every
 *   platform (Cache Storage API works inside the Tauri WebView too), and are always safe to
 *   clear - everything in them is re-fetchable from the server.
 * - Message history and the MLS encryption state are measured differently per platform: native
 *   reads real file sizes via a Rust command (`get_local_storage_usage`), while the web build has
 *   no per-database size API and falls back to `navigator.storage.estimate()`'s origin-wide total
 *   minus the (precisely measured) cache size. `mls.bin` is reported separately ONLY on native,
 *   and must never be offered by a "clear cache" action - it is identity and key material.
 */

import { isTauriRuntime } from '$lib/utils/openExternal';
import { invoke } from '@tauri-apps/api/core';
import { CIPHER_CACHE_NAME } from './mediaBlobCache';
import { CACHE_NAME as ASSOCIATION_LOGO_CACHE_NAME } from './associationLogoCache';

/**
 * The buckets this panel measures and clears. BOTH ARE KEYED BY A CONTENT: an encrypted media id
 * and an immutable `/api/media/public/<mediaId>` logo. User avatars are NOT here and must not come
 * back: their URL names a person, so they are the browser's HTTP cache to keep and to expire
 * (`userAvatarCache.ts`).
 */
const MEDIA_CACHE_NAMES = [CIPHER_CACHE_NAME, ASSOCIATION_LOGO_CACHE_NAME];

export interface DeviceStorageUsage {
  /** Media/logo Cache Storage buckets - always safe to clear, always re-fetchable. */
  mediaCacheBytes: number;
  /** Message history and the local database. On native this excludes `mls.bin`; on web it is
   * `estimate()`'s total minus the cache, so it also includes the MLS IndexedDB store there. */
  messagesBytes: number;
  /** `mls.bin` size - native only. Always `null` on web, where it is not separately measurable
   * and is folded into `messagesBytes` instead (never omitted from the total, never offered as
   * clearable). */
  encryptionStateBytes: number | null;
  /** Sum of the three above - the number to show as "total used by Canari". */
  totalBytes: number;
}

/** Sums the Content-Length of every entry across the media/logo Cache Storage buckets. */
async function measureCacheStorageBytes(): Promise<number> {
  if (typeof caches === 'undefined') return 0;

  let total = 0;
  for (const name of MEDIA_CACHE_NAMES) {
    let cache: Cache;
    try {
      cache = await caches.open(name);
    } catch {
      continue;
    }
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) continue;
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        total += parseInt(contentLength, 10) || 0;
        continue;
      }
      // No Content-Length header (rare, but happens for some opaque/synthetic responses) -
      // read the body itself. Already fully on disk in the cache, so this costs no network.
      total += (await response.clone().blob()).size;
    }
  }
  return total;
}

/** Deletes every media/logo Cache Storage bucket. Never touches messages or `mls.bin`. */
export async function clearMediaCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(MEDIA_CACHE_NAMES.map((name) => caches.delete(name)));
}

/**
 * Reports how much local storage Canari is using, split into the categories above.
 * Never throws: an unmeasurable platform/browser combination reports zeros rather than failing
 * the whole Settings page.
 */
export async function getDeviceStorageUsage(): Promise<DeviceStorageUsage> {
  const mediaCacheBytes = await measureCacheStorageBytes();

  if (isTauriRuntime()) {
    try {
      const usage = await invoke<{
        messages_bytes: number;
        encryption_state_bytes: number;
        other_bytes: number;
      }>('get_local_storage_usage');
      const messagesBytes = usage.messages_bytes + usage.other_bytes;
      const encryptionStateBytes = usage.encryption_state_bytes;
      return {
        mediaCacheBytes,
        messagesBytes,
        encryptionStateBytes,
        totalBytes: mediaCacheBytes + messagesBytes + encryptionStateBytes,
      };
    } catch {
      // Fall through to reporting just the cache - better than failing the whole panel.
      return {
        mediaCacheBytes,
        messagesBytes: 0,
        encryptionStateBytes: null,
        totalBytes: mediaCacheBytes,
      };
    }
  }

  let totalOriginBytes = 0;
  try {
    const estimate = await navigator.storage?.estimate?.();
    totalOriginBytes = estimate?.usage ?? 0;
  } catch {
    totalOriginBytes = 0;
  }
  // The cache is a subset of the origin total; never let rounding/timing between the two
  // measurements (taken a moment apart) produce a negative "everything else".
  const messagesBytes = Math.max(0, totalOriginBytes - mediaCacheBytes);
  return {
    mediaCacheBytes,
    messagesBytes,
    encryptionStateBytes: null,
    totalBytes: mediaCacheBytes + messagesBytes,
  };
}

/** Formats a byte count for display, e.g. `4.2 Mo`. Base 1024, French unit letters. */
export function formatStorageBytes(bytes: number): string {
  if (bytes <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
