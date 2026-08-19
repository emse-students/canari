/**
 * Client for the backend counterpart of `deviceStorage.ts` (WP-DEVICESTORAGE-1): reports what the
 * SERVER itself is using, distinct from the client's own local storage. Display-only - there is no
 * "clear" action here, unlike the media cache on-device, since none of these numbers are something
 * an admin should be deleting from a UI button.
 *
 * The media bucket is more than a total on purpose. A bucket that grows looks identical whether
 * people are uploading more or the retention sweep has stopped removing anything, and those two
 * have opposite fixes - so the breakdown below exists to tell them apart, and
 * {@link classifyRetention} turns it into the one sentence a reader actually needs.
 */

import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';

/** The media bucket's breakdown. Field meanings live with `MediaService.getStorageStats`. */
export interface MediaBucketUsage {
  totalBytes: number;
  objectCount: number;
  /** Bytes last written in each of the last four 7-day windows, index 0 being the most recent. */
  recentBytesByWeek: number[];
  olderBytes: number;
  undatedCount: number;
  overdueCount: number;
  overdueBytes: number;
  overdueOldestMs: number | null;
  untrackedCount: number;
  untrackedBytes: number;
  tombstonedCount: number;
  tombstonedBytes: number;
  publicAssetCount: number;
  publicAssetBytes: number;
  retentionMs: number;
  sweepIntervalMs: number;
}

/** One MLS table: `pg_total_relation_size` (indexes and TOAST included) and the planner's row estimate. */
export interface MlsTableUsage {
  table: string;
  bytes: number;
  rows: number;
}

/**
 * The undelivered queue, as four numbers rather than one.
 *
 * A queue is SUPPOSED to have rows in it - an offline device has messages waiting. What is not
 * supposed to happen is one device accumulating without end, which is what a dead or revoked device
 * looks like: the fleet total stays unremarkable while a single queue grows forever. `deepest` is
 * what separates forty devices with twenty messages from one device with eight hundred.
 */
export interface MlsQueueUsage {
  rows: number;
  devices: number;
  deepest: number;
  oldestMs: number | null;
  /** Rows created in each of the last four 7-day windows, index 0 being the current week. */
  rowsByWeek: number[];
}

/**
 * The WP-GHOST-1 shape: a device holding group memberships that has published no key package, so it
 * can be added to nothing and can receive no Welcome. Found by hand once and measured nowhere since.
 */
export interface MlsGhostUsage {
  devicesWithMemberships: number;
  devicesWithoutKeyPackage: number;
  orphanMemberships: number;
}

/** Redis by key prefix. `keys` is exact; the breakdown is a bounded SCAN sample of `sampled` keys. */
export interface RedisKeyspaceUsage {
  keys: number;
  sampled: number;
  byPrefix: { prefix: string; keys: number }[];
}

export interface MlsUsage {
  tables: MlsTableUsage[];
  queue: MlsQueueUsage | null;
  ghosts: MlsGhostUsage | null;
  redisKeyspace: RedisKeyspaceUsage | null;
}

export interface BackendStorageUsage {
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  postgresBytes: number | null;
  redisBytes: number | null;
  media: MediaBucketUsage | null;
  /**
   * The MLS half. Postgres and Redis are bare totals above; this is what they are made of, and it
   * is DISPLAY ONLY - the user's call of 2026-08-17 was a panel and no alert, so nothing here
   * classifies, warns or acts. A number a reader can see beats a threshold nobody measured.
   */
  mls: MlsUsage | null;
}

/**
 * What the overdue objects mean, which is not the same question as how many there are.
 *
 * An object becomes overdue the moment its retention window closes, and the sweep only runs every
 * `sweepIntervalMs` - so a small overdue count is the ordinary gap between those two events, not a
 * fault. It is a fault when the OLDEST overdue object has survived a full sweep interval, because
 * that means a pass ran and did not take it.
 */
export type RetentionVerdict =
  | { kind: 'healthy' }
  | { kind: 'pending'; count: number; bytes: number }
  | { kind: 'stalled'; count: number; bytes: number; oldestMs: number };

export function classifyRetention(media: MediaBucketUsage): RetentionVerdict {
  if (media.overdueCount === 0) return { kind: 'healthy' };
  const oldestMs = media.overdueOldestMs ?? 0;
  // The age is measured from the object's last access, so a full retention window has already
  // elapsed before it counts as overdue at all - hence the comparison against retention + one sweep.
  if (oldestMs > media.retentionMs + media.sweepIntervalMs) {
    return {
      kind: 'stalled',
      count: media.overdueCount,
      bytes: media.overdueBytes,
      oldestMs,
    };
  }
  return { kind: 'pending', count: media.overdueCount, bytes: media.overdueBytes };
}

/**
 * Objects the sweep cannot reach at all, which no amount of waiting will clear.
 *
 * Two causes, kept apart because the second becomes the first: an object with no metadata entry is
 * invisible to a sweep that only ever iterates the metadata, and a tombstoned entry whose object is
 * still there is a delete that failed - it turns into the first case once the tombstone is trimmed.
 */
export function unreachableBytes(media: MediaBucketUsage): number {
  return media.untrackedBytes + media.tombstonedBytes;
}

/**
 * Fetches the backend storage breakdown from `chat-delivery-service`. Each field independently
 * measured server-side, so a `null` field means that ONE measurement failed (e.g. media-service
 * unreachable for the bucket figures), never that the whole request did - only a non-2xx response
 * or a network failure throws.
 */
export async function getBackendStorageUsage(): Promise<BackendStorageUsage> {
  const response = await apiFetch(`${deliveryUrl()}/api/mls/admin/storage`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
