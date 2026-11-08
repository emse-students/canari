/**
 * THE FEED CARD'S SIDE OF THE PREVIEW IMAGE (owner, 2026-11-07): fetch the sealed still the list
 * named, open it under the POSTER key the list served with it, and hand back a JPEG blob - or
 * nothing, with the reason logged and typed. The card keeps the picture it already shows when a
 * newer one fails: a preview is a convenience, and nothing is decided from it.
 *
 * No seat is taken, and no key that opens the stream: the poster key comes from `GET /api/lives`
 * (derived from the live key, it opens this picture and nothing else), the bytes from the poster's
 * own public path, which nginx serves from its cache and counts apart from the segments.
 *
 * A POSTER IS FETCHED ONCE (review of #3135): the newest opened image of each live is kept here by
 * its NAME, so a list refresh naming the same poster, or a card drawn again (one live becoming a
 * carousel, a tab switch), asks the network nothing. Only a NEW name is fetched. The card drops the
 * entries of the lives no longer listed ({@link forgetLivePostersExcept}), so this holds one image
 * per live on air at most. Never logs the key or the bytes, lengths only.
 */
import { fetchLivePoster, isLiveRefusal } from './api';
import { LivePosterOpenError, openLivePoster } from './livePosterCrypto';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type { LiveListItem } from './types';

/** How one poster load ended - every way is a value, so the card never parses a message. */
export type LivePosterLoad =
  | { kind: 'shown'; image: Blob }
  /** The list named no poster (none stored yet, or its key would not open server side). */
  | { kind: 'none' }
  /** The object was replaced or purged between the list and the fetch: the next list names the new one. */
  | { kind: 'gone' }
  | { kind: 'offline' }
  /** nginx's per-address preview budget answered 429: the next period asks again. */
  | { kind: 'rate-limited' }
  | { kind: 'aborted' }
  /** It did not open under the served key, or the server refused it otherwise. */
  | { kind: 'failed' };

/** What a load needs; the real fetch and open unless a test hands its own. */
export interface LivePosterViewDeps {
  fetch: typeof fetchLivePoster;
  open: typeof openLivePoster;
}

const DEFAULT_DEPS: LivePosterViewDeps = { fetch: fetchLivePoster, open: openLivePoster };

/** The newest opened poster of each live, by live id: its name and its image. */
const opened = new Map<string, { name: string; image: Blob }>();

/** Drops the kept image of every live not in `liveIds` - the card calls it with each new list. */
export function forgetLivePostersExcept(liveIds: Iterable<string>): void {
  const keep = new Set(liveIds);
  for (const id of opened.keys()) {
    if (!keep.has(id)) {
      opened.delete(id);
      console.debug(`[LIVE] card poster ${id}: forgotten (no longer listed)`);
    }
  }
}

/** Loads and opens the preview a list item names - from the network only when its name is new. */
export async function loadLivePoster(
  live: Pick<LiveListItem, 'id' | 'poster' | 'posterKey'>,
  signal?: AbortSignal,
  deps: LivePosterViewDeps = DEFAULT_DEPS
): Promise<LivePosterLoad> {
  const poster = live.poster;
  if (!poster || !live.posterKey) {
    console.debug(`[LIVE] card poster ${live.id}: none listed`);
    return { kind: 'none' };
  }
  const kept = opened.get(live.id);
  if (kept?.name === poster.name) {
    console.debug(`[LIVE] card poster ${live.id}: ${poster.name} already opened - no fetch`);
    return { kind: 'shown', image: kept.image };
  }
  console.debug(`[LIVE] card poster ${live.id}: loading ${poster.name} (${poster.ageMs} ms old)`);
  try {
    const sealed = new Uint8Array(await deps.fetch(live.id, poster.name, signal));
    const plain = await deps.open(live.posterKey, live.id, sealed);
    console.debug(`[LIVE] card poster ${live.id}: opened, ${plain.byteLength} bytes`);
    const image = new Blob([plain], { type: 'image/jpeg' });
    opened.set(live.id, { name: poster.name, image });
    return { kind: 'shown', image };
  } catch (e) {
    if (signal?.aborted) {
      console.debug(`[LIVE] card poster ${live.id}: aborted`);
      return { kind: 'aborted' };
    }
    if (isTransportFailure(e)) {
      console.log(`[LIVE] card poster ${live.id}: no answer - the card keeps what it shows`);
      return { kind: 'offline' };
    }
    if (isLiveRefusal(e, 'not-found')) {
      console.debug(`[LIVE] card poster ${live.id}: ${poster.name} already replaced or purged`);
      return { kind: 'gone' };
    }
    if (isLiveRefusal(e, 'rate-limited')) {
      // The preview's own nginx budget doing its job: a stale picture, never a seated viewer's 429.
      console.log(
        `[LIVE] card poster ${live.id}: 429 from the preview budget - the card keeps what it shows`
      );
      return { kind: 'rate-limited' };
    }
    if (e instanceof LivePosterOpenError) {
      console.warn(`[LIVE] card poster ${live.id}: did not open (${e.reason}) - no picture`);
      return { kind: 'failed' };
    }
    console.warn(`[LIVE] card poster ${live.id}: refused (${String(e)}) - no picture`);
    return { kind: 'failed' };
  }
}
