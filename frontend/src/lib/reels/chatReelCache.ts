/**
 * A conversation reel's LOCAL copy, dropped once its tile is a tombstone (RC-6,
 * [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md) 3.3).
 *
 * Once per media id per page life: a tombstone is drawn on every mount of its row, and the cache
 * delete it owes is owed once - the next page life asks again, which is what makes it durable
 * without a record of its own (a delete of an absent entry is a no-op).
 */
import { evictCachedReelCiphertext } from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';

const dropped = new Set<string>();

/** The eviction, injectable so a test counts the calls without a Cache API. */
export type ReelCopyEvictor = (mediaId: string, baseUrl: string) => Promise<void>;

/**
 * Drop the cached ciphertext of a gone reel, once per page life.
 *
 * @returns whether the eviction was asked now (`false`: already asked, or no media id).
 */
export function dropGoneReelCopy(
  mediaId: string,
  evict: ReelCopyEvictor = evictCachedReelCiphertext
): boolean {
  if (!mediaId || dropped.has(mediaId)) return false;
  dropped.add(mediaId);
  void evict(mediaId, mediaUrl());
  return true;
}

/** Test seam: forget what this page life already dropped. */
export function resetGoneReelCopiesForTest(): void {
  dropped.clear();
}
