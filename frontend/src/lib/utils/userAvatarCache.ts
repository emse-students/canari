const CACHE_NAME = 'canari-user-avatars-v1';

/** In-memory blob URLs for the current session (revoked when last consumer releases). */
const sessionBlobByUrl = new Map<string, string>();
/** Reference count per canonical avatar URL (several avatars can share one blob). */
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
 * Resolves a user avatar HTTP URL to a display URL.
 * Uses the Cache API when available so avatars are kept across sessions until storage is cleared.
 */
export async function resolveUserAvatarDisplayUrl(httpUrl: string | null): Promise<string | null> {
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
      if (!fetched.ok) return url;
      await cache.put(url, fetched.clone());
      response = fetched;
    }
    const blob = await response.blob();
    if (!blob.size) return url;
    const blobUrl = URL.createObjectURL(blob);
    return retainBlobUrl(url, blobUrl);
  } catch {
    return url;
  }
}

/** Decrements the ref count and revokes the blob URL when no avatar still uses it. */
export function releaseUserAvatarDisplayUrl(httpUrl: string | null): void {
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
