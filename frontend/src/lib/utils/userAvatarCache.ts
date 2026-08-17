import { Log } from '$lib/utils/Log';

/**
 * The Cache Storage bucket this module used to write, kept ONLY so it can be deleted.
 *
 * It held avatars keyed by `/api/users/<id>/avatar`, and `cache.match()` performs no freshness
 * check of any kind: Cache Storage is a plain key/value store and ignores `Cache-Control`
 * entirely. So the server's 24 h `max-age` governed an HTTP cache that was never consulted again,
 * and the first photo a device ever drew for a face was the photo it kept FOR EVER - the only
 * eviction being the Settings "clear media cache" button. Three devices, three first draws, three
 * different faces for the same person, indefinitely.
 *
 * A KEY NAMING A CONTENT MAY BE CACHED FOR EVER; A KEY NAMING AN IDENTITY MAY NOT. This URL names
 * a person, and the photo behind it is MiGallery's to change at any time.
 */
const RETIRED_CACHE_NAME = 'canari-user-avatars-v1';

/** Live blob URL per canonical avatar URL, held while at least one avatar displays it. */
const sessionBlobByUrl = new Map<string, string>();
/** Reference count per canonical avatar URL (several avatars can share one blob). */
const blobRefCount = new Map<string, number>();
/** In-progress load per canonical avatar URL, so N simultaneous mounts cost ONE request. */
const inFlightByUrl = new Map<string, Promise<AvatarDisplay>>();

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
 * Reads one avatar from the network, or from the HTTP cache when it is still fresh.
 *
 * Refcounting is deliberately NOT done here: this promise is shared between every caller that
 * asked for the same face while it was in flight, and each of them retains the result separately.
 */
async function loadAvatar(url: string): Promise<AvatarDisplay> {
  try {
    const fetched = await fetch(url, { credentials: 'include', mode: 'cors' });
    // A RESPONSE THAT IS NOT OK IS STILL AN ANSWER. Handing the same URL to an `<img>` would ask
    // the same server the same question and receive the same refusal, at the cost of a second
    // request and a second console line.
    if (!fetched.ok) return { kind: 'none' };
    const blob = await fetched.blob();
    if (!blob.size) return { kind: 'none' };
    return { kind: 'blob', url: URL.createObjectURL(blob) };
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

/**
 * Resolves a user avatar HTTP URL to something displayable.
 *
 * HOW LONG AN AVATAR LIVES IS NOT DECIDED HERE, AND IS NOT DECIDED TWICE. The server states it on
 * the response itself - 24 h for an image, 10 min for an absence, `no-store` for an outage - and
 * the browser's own HTTP cache is what honours it. This function keeps nothing across sessions,
 * because a second store would need a second lifetime, and the one it used to keep had none at all
 * (see `RETIRED_CACHE_NAME`). What it does keep is a blob for the CURRENT mounts of one face, so a
 * directory listing the same person twenty times costs one request and one decode, not twenty.
 */
export async function resolveUserAvatarDisplayUrl(httpUrl: string | null): Promise<AvatarDisplay> {
  if (!httpUrl?.trim()) return { kind: 'none' };
  const url = httpUrl.trim();

  const held = sessionBlobByUrl.get(url);
  if (held) return { kind: 'blob', url: retainBlobUrl(url, held) };

  // ONE REQUEST FOR N SIMULTANEOUS MOUNTS. The map above cannot dedupe them - it is only written
  // once the bytes are in - so without this every face in a freshly rendered list would ask for
  // itself once per occurrence, and the HTTP cache cannot coalesce requests already in flight.
  let pending = inFlightByUrl.get(url);
  if (!pending) {
    pending = loadAvatar(url);
    inFlightByUrl.set(url, pending);
    void pending.finally(() => inFlightByUrl.delete(url));
  }

  const loaded = await pending;
  if (loaded.kind !== 'blob') return loaded;
  return { kind: 'blob', url: retainBlobUrl(url, loaded.url) };
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

/**
 * Deletes the retired avatar bucket, once per start, on every client that still has one.
 *
 * The stale photos it holds are no longer READ by anything, but they are still bytes on a device -
 * one per face the user ever saw - and nothing else would ever reclaim them. `caches.delete` on a
 * name that is already gone resolves `false` and costs nothing, so this needs no flag recording
 * that it ran: THE ABSENCE OF THE BUCKET IS THE DURABLE STATE.
 */
export async function purgeRetiredAvatarCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const existed = await caches.delete(RETIRED_CACHE_NAME);
    if (existed) Log.d('AvatarCache', `deleted the retired bucket ${RETIRED_CACHE_NAME}`);
  } catch (e) {
    // Best effort by nature: failing to reclaim old bytes must never keep faces from drawing.
    Log.d('AvatarCache', `could not delete ${RETIRED_CACHE_NAME}: ${String(e)}`);
  }
}
