/**
 * WHICH ARRIVALS A BULK-INGEST WINDOW HOLDS FOR ITS ONE FLUSH, AND WHICH IT LETS THROUGH TO THE LIVE
 * PATH (`useMessaging.addMessageToChat`).
 *
 * The window exists so that a drain lands in the open conversation in ONE render (`batchAddMessages`
 * at its close) with ONE store write per conversation, instead of a render, a store read and a store
 * write per message. Every message it lets through pays all three: measured on the owner's Android
 * (`1.7.3`, 2026-11-24, a 148-frame catch-up of one DM), EVERY text of the drain went live - 34
 * push-preview upgrades at ~80 ms each and 23 messages written from the owner's other device at
 * ~90 ms each, 4.8 s of a 9.5 s drain - and the open pane took them one row at a time.
 *
 * Only two kinds of arrival may not wait for the flush, and both are about who else would write them:
 *
 * - **a message THIS device composed** (no frame behind it). MLS gives no echo, so this call is the
 *   only writer its row will ever get, and a buffer discarded unflushed by a second drain lost it
 *   (WP-ECHO-1). An own message DECRYPTED FROM A FRAME - written on this account's other device - is
 *   not that case: its frame stays on the server until the window's close stored its row (rows
 *   before ratchet, the ack), exactly like a peer's message, so it is held like one;
 * - **a notice whose only writer is this call** (`soleWriter`: the acting device's own visible
 *   notice under a `system` sender) - the same reason as an own send.
 *
 * An UPGRADE of a shown push preview is held too: `batchAddMessages` upgrades a shown preview
 * (`shouldUpgradeMessage`) and writes it by compare-and-set (`mergeShownUpgrades`) like the live
 * path does, and its frame's ack waits for the close's store like every buffered frame's.
 */
export interface BulkArrival {
  /** The author is this account (`isOwnMessage`). */
  own: boolean;
  /** The message was decrypted from a queued frame (`AddMessageToChatOptions.frameId`). */
  framed: boolean;
  /** The caller is the only writer this row will ever have (`AddMessageToChatOptions.soleWriter`). */
  soleWriter: boolean;
}

/** Whether an open bulk-ingest window holds this arrival for its flush ({@link BulkArrival}). */
export function bulkWindowHolds(arrival: BulkArrival): boolean {
  if (arrival.soleWriter) return false;
  return !arrival.own || arrival.framed;
}
