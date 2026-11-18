import { Log } from '$lib/utils/Log';

/**
 * THE SALON ROWS REMOVED LIVE WHILE A PAGE WAS IN HAND, so the page cannot put them back.
 *
 * The server HARD-deletes a salon message (no tombstone), and a live removal - the reader's own
 * delete or a `channel.message.deleted` broadcast - can only mark a row that is already on screen.
 * A page fetched before it still carries the row, and a load or a search merging that page later
 * (seconds of decoding, or a key-group drain that lasts as long as the link is down) inserted it
 * again: a deleted message back on screen until the next load removed it - a race that healed, and
 * so a defect. This is the overlap named and deleted: every page read opens a watch BEFORE its
 * request leaves, every live removal is noted in every open watch, and the reader skips the noted
 * ids. A removed row is gone for good on the server, so skipping it is right whatever the page holds.
 *
 * Keyed by the server message id alone: ids are unique across salons. Bounded by the reads in
 * flight - a watch holds only what was removed during its own life, and is dropped when it closes.
 */
export interface SalonRemovalWatch {
  /** Whether the row was removed live since this watch opened. */
  has(messageId: string): boolean;
  /** Ends the watch; the ids it saw go with it. Idempotent. */
  close(): void;
}

const openWatches = new Set<Set<string>>();

/** Opens a watch, BEFORE the request of the page it guards leaves (see the module doc). */
export function watchSalonRemovals(): SalonRemovalWatch {
  const removed = new Set<string>();
  openWatches.add(removed);
  return {
    has: (messageId) => removed.has(messageId),
    close: () => {
      openWatches.delete(removed);
    },
  };
}

/**
 * Notes a salon row removed live - whether or not a copy of it is on screen. Called by the ONE path
 * every live removal takes (`markChannelMessageDeleted`).
 */
export function noteSalonRowRemoved(messageId: string): void {
  if (!messageId) return;
  if (openWatches.size > 0) {
    Log.d(
      'CHANNEL',
      `row ${messageId.slice(0, 8)} removed live - noted by ${openWatches.size} page read(s) in hand`
    );
  }
  for (const removed of openWatches) removed.add(messageId);
}
