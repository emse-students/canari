const CACHE_NAME = 'canari-association-logos-v1';

/** In-memory blob URLs for the current session (revoked when last consumer releases). */
const sessionBlobByUrl = new Map<string, string>();
/** Reference count per canonical logo URL (several avatars can share one blob). */
const blobRefCount = new Map<string, number>();

function retainBlobUrl(canonicalUrl: string, blobUrl: string): string {
  const prior = sessionBlobByUrl.get(canonicalUrl);
  if (prior?.startsWith('blob:') && prior !== blobUrl) {
    URL.revokeObjectURL(prior);
  }
  sessionBlobByUrl.set(canonicalUrl, blobUrl);
  blobRefCount.set(canonicalUrl, (blobRefCount.get(canonicalUrl) ?? 0) + 1);
  return blobUrl;
}

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

  const cached = sessionBlobByUrl.get(url);
  if (cached) {
    blobRefCount.set(url, (blobRefCount.get(url) ?? 0) + 1);
    return cached;
  }

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
    return retainBlobUrl(url, blobUrl);
  } catch (e) {
    console.log('[associationLogoCache] cache miss', e);
    return url;
  }
}

/** Decrements the ref count and revokes the blob URL when no avatar still uses it. */
export function releaseAssociationLogoDisplayUrl(httpUrl: string | null): void {
  if (!httpUrl) return;
  const url = httpUrl.trim();
  const next = (blobRefCount.get(url) ?? 1) - 1;
  if (next > 0) {
    blobRefCount.set(url, next);
    return;
  }
  blobRefCount.delete(url);
  const blobUrl = sessionBlobByUrl.get(url);
  if (blobUrl?.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
  sessionBlobByUrl.delete(url);
}
