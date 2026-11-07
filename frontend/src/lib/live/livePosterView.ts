/**
 * THE FEED CARD'S SIDE OF THE PREVIEW IMAGE (owner, 2026-11-07): fetch the sealed still the list
 * named, open it under the key the list served with it, and hand back a JPEG blob - or nothing, with
 * the reason logged and typed. The card keeps the picture it already shows when a newer one fails:
 * a preview is a convenience, and nothing is decided from it.
 *
 * No seat is taken: the key comes from `GET /api/lives` (the list's audience), and the bytes from the
 * public, nginx-cached object route a segment uses. Never logs the key or the bytes, lengths only.
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
  | { kind: 'aborted' }
  /** It did not open under the served key, or the server refused it otherwise. */
  | { kind: 'failed' };

/** What a load needs; the real fetch and open unless a test hands its own. */
export interface LivePosterViewDeps {
  fetch: typeof fetchLivePoster;
  open: typeof openLivePoster;
}

const DEFAULT_DEPS: LivePosterViewDeps = { fetch: fetchLivePoster, open: openLivePoster };

/** Loads and opens the preview a list item names. */
export async function loadLivePoster(
  live: Pick<LiveListItem, 'id' | 'poster' | 'key'>,
  signal?: AbortSignal,
  deps: LivePosterViewDeps = DEFAULT_DEPS
): Promise<LivePosterLoad> {
  const poster = live.poster;
  if (!poster || !live.key) {
    console.debug(`[LIVE] card poster ${live.id}: none listed`);
    return { kind: 'none' };
  }
  console.debug(`[LIVE] card poster ${live.id}: loading ${poster.name} (${poster.ageMs} ms old)`);
  try {
    const sealed = new Uint8Array(await deps.fetch(live.id, poster.name, signal));
    const plain = await deps.open(live.key, live.id, sealed);
    console.debug(`[LIVE] card poster ${live.id}: opened, ${plain.byteLength} bytes`);
    return { kind: 'shown', image: new Blob([plain], { type: 'image/jpeg' }) };
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
    if (e instanceof LivePosterOpenError) {
      console.warn(`[LIVE] card poster ${live.id}: did not open (${e.reason}) - no picture`);
      return { kind: 'failed' };
    }
    console.warn(`[LIVE] card poster ${live.id}: refused (${String(e)}) - no picture`);
    return { kind: 'failed' };
  }
}
