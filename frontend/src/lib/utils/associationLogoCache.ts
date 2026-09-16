import { BlobUrlPool } from '$lib/utils/blobUrlPool';

/** Exported so `deviceStorage.ts` can measure/clear it without duplicating the literal. */
export const CACHE_NAME = 'canari-association-logos-v1';

/**
 * This module's own pool - the counting is shared, the STATE is not.
 *
 * `evictDelayMs: 0` because these bytes are not worth keeping past their last holder: the delayed
 * eviction the pool defaults to exists for decrypted media, which is expensive to produce again.
 * Uncapped for the same reason it always was: the bound is how many faces are on screen.
 */
const blobs = new BlobUrlPool({ evictDelayMs: 0, maxEntries: Infinity });

/**
 * Resolves an association logo HTTP URL to a display URL.
 * Uses the Cache API when available so logos are kept across sessions until storage is cleared.
 * Falls back to the original URL when caching is unavailable or the fetch fails.
 */
export async function resolveAssociationLogoDisplayUrl(
  httpUrl: string | null
): Promise<string | null> {
  if (!httpUrl?.trim()) return null;
  const url = httpUrl.trim();

  const cached = blobs.tryRetain(url);
  if (cached) return cached;

  if (typeof caches === 'undefined') {
    return url;
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(url);
    if (!response) {
      const fetched = await fetch(url, { credentials: 'include', mode: 'cors' });
      if (!fetched.ok) {
        console.log('[associationLogoCache] fetch failed', fetched.status, url);
        return url;
      }
      await cache.put(url, fetched.clone());
      response = fetched;
    }
    const blob = await response.blob();
    if (!blob.size) {
      console.log('[associationLogoCache] empty blob', url);
      return url;
    }
    const blobUrl = URL.createObjectURL(blob);
    return blobs.retain(url, blobUrl);
  } catch (e) {
    console.log('[associationLogoCache] cache miss', e);
    return url;
  }
}

/** Decrements the ref count and revokes the blob URL when no consumer still uses it. */
export function releaseAssociationLogoDisplayUrl(httpUrl: string | null): void {
  // Trimmed exactly as the resolve side keys it, or a caller's stray space leaks a blob.
  blobs.release(httpUrl?.trim() ?? null);
}
