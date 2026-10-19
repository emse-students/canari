/**
 * THE LIVES THE FEED'S LIVE CARD LISTS (WP-L5, decision L5/D4: a LIVE card at the top of the feed).
 *
 * `GET /api/lives` already applies the watch rule (a live follows a post's visibility,
 * docs/wiki/services/lives.md, "Who may watch"), so the reader's own live is the only one filtered
 * here: the broadcaster watches it from the broadcast screen, not from a card. The list is asked
 * when the FEED asks for its first page (a tab load, a pull-to-refresh, a retry, a reconnect) -
 * the feed's own mechanism, no timer of its own.
 */

import { isLiveRefusal, listOpenLives } from './api';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type { LiveListItem } from './types';

/** What one refresh of the card decided. */
export type OpenLivesOutcome =
  /** The server's list, filtered for this reader. */
  | { kind: 'answered'; lives: LiveListItem[] }
  /** No answer: what the card shows stays (it is at most one feed refresh old). */
  | { kind: 'kept' }
  /** The server said no (the switch off, or a refusal): the card shows nothing. */
  | { kind: 'hidden' };

/** The lives a reader's card lists: the server's order (newest first), the reader's own left out. */
export function livesForFeed(lives: LiveListItem[], viewerId: string | null): LiveListItem[] {
  return viewerId ? lives.filter((l) => l.broadcasterId !== viewerId) : lives;
}

/** Asks the server for the open lives and decides what the card does with the answer. */
export async function loadOpenLivesForFeed(
  viewerId: string | null,
  list: () => Promise<LiveListItem[]> = listOpenLives
): Promise<OpenLivesOutcome> {
  try {
    const lives = livesForFeed(await list(), viewerId);
    console.debug(`[LIVE] feed card: ${lives.length} open live(s)`);
    return { kind: 'answered', lives };
  } catch (e) {
    if (isTransportFailure(e)) {
      console.log('[LIVE] feed card: no answer from the server - the card keeps what it shows');
      return { kind: 'kept' };
    }
    if (isLiveRefusal(e, 'disabled')) {
      console.debug('[LIVE] feed card: lives are switched off on this estate');
      return { kind: 'hidden' };
    }
    console.warn(`[LIVE] feed card: the list was refused (${String(e)}) - no card`);
    return { kind: 'hidden' };
  }
}

/** The live's age as a clock face: `m:ss` under an hour, `h:mm:ss` from it. */
export function formatLiveElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
