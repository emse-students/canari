const CACHE_NAME = 'canari-association-logos-v1';

/** In-memory blob URLs for the current session (revoked on replace). */
const sessionBlobByUrl = new Map<string, string>();

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
    const blobUrl = URL.createObjectURL(blob);
    const prior = sessionBlobByUrl.get(url);
    if (prior?.startsWith('blob:')) URL.revokeObjectURL(prior);
    sessionBlobByUrl.set(url, blobUrl);
    return blobUrl;
  } catch (e) {
    console.log('[associationLogoCache] cache miss', e);
    return url;
  }
}

/** Revokes blob URLs created for a given canonical logo URL. */
export function releaseAssociationLogoDisplayUrl(httpUrl: string | null): void {
  if (!httpUrl) return;
  const url = httpUrl.trim();
  const blobUrl = sessionBlobByUrl.get(url);
  if (blobUrl?.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
  sessionBlobByUrl.delete(url);
}
