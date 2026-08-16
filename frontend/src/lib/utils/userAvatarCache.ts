import { Log } from '$lib/utils/Log';

/** Exported so `deviceStorage.ts` can measure/clear it without duplicating the literal. */
export const CACHE_NAME = 'canari-user-avatars-v1';

/** In-memory blob URLs for the current session (revoked when last consumer releases). */
const sessionBlobByUrl = new Map<string, string>();
/** Reference count per canonical avatar URL (several avatars can share one blob). */
const blobRefCount = new Map<string, number>();

/**
 * What to draw for one avatar, and where the bytes are.
 *
 * IT IS A KIND AND NOT A NULLABLE URL because the three cases lead to three different renders, and
 * the previous `string | null` collapsed two of them: a miss returned the HTTP URL, which the
 * caller then handed to an `<img>`, which asked the server AGAIN for the answer we had just been
 * given. Every face without a photo therefore cost two requests per mount, for ever - the exact
 * amplification that turns one transient upstream fault into a burst of failures rather than a line.
 */
export type AvatarDisplay =
  /** Bytes are held locally; `url` is a blob URL and must be released. */
  | { readonly kind: 'blob'; readonly url: string }
  /** Nothing was cached, but the `<img>` may fetch it itself - one request, as before. */
  | { readonly kind: 'direct'; readonly url: string }
  /** The server answered, and there is no image to show. Draw initials, ask nobody. */
  | { readonly kind: 'none' };

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
 * Resolves a user avatar HTTP URL to something displayable.
 *
 * Uses the Cache API when available so avatars are kept across sessions until storage is cleared.
 * How long a MISS is remembered is not decided here: the server states it on the 404 itself
 * (`Cache-Control: max-age`), so the browser's own HTTP cache is what suppresses the repeat, and
 * there is exactly one lifetime for this in the system instead of one per layer.
 */
export async function resolveUserAvatarDisplayUrl(httpUrl: string | null): Promise<AvatarDisplay> {
  if (!httpUrl?.trim()) return { kind: 'none' };
  const url = httpUrl.trim();

  const cached = sessionBlobByUrl.get(url);
  if (cached) {
    blobRefCount.set(url, (blobRefCount.get(url) ?? 0) + 1);
    return { kind: 'blob', url: cached };
  }

  if (typeof caches === 'undefined') {
    return { kind: 'direct', url };
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(url);
    if (!response) {
      const fetched = await fetch(url, { credentials: 'include', mode: 'cors' });
      // A RESPONSE THAT IS NOT OK IS STILL AN ANSWER. Handing the same URL to an `<img>` would ask
      // the same server the same question and receive the same refusal, at the cost of a second
      // request and a second console line.
      if (!fetched.ok) return { kind: 'none' };
      await cache.put(url, fetched.clone());
      response = fetched;
    }
    const blob = await response.blob();
    if (!blob.size) return { kind: 'none' };
    return { kind: 'blob', url: retainBlobUrl(url, URL.createObjectURL(blob)) };
  } catch (e) {
    // WE NEVER GOT AN ANSWER - not the same thing as being told there is none. A cross-origin
    // refusal is the case that matters: on the native clients the API is a different origin from
    // the app, and an `<img>` is not subject to CORS where `fetch` is, so the element can still
    // render what this function could not read. It is a different QUESTION, not a retry of this
    // one - but it is a degraded path, so it says so rather than passing silently.
    Log.d('AvatarCache', `could not read ${url}, leaving it to the element: ${String(e)}`);
    return { kind: 'direct', url };
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
