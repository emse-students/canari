/**
 * The ordering key of a message row, alone in a module with no imports so the storage layer can
 * page on the very function the timeline sorts on (`$lib/db`, `order_at` / `orderAt`) without
 * pulling the rendering helpers of `messageOrder.ts` in with it.
 */

/**
 * What the key reads: a chat row (`timestamp` a `Date`) or a stored one (`timestamp` in ms), and
 * the server's receive time when the row knows it.
 */
export interface DatedRow {
  timestamp: Date | number;
  serverTimestamp?: number;
}

/**
 * THE INSTANT A ROW IS ORDERED, SHOWN AND READ AT: the time the SERVER accepted it when the row
 * knows it, the author's stamped `timestamp` (`sentAt`) otherwise (decided by the owner 2026-10-31).
 *
 * A salon row has always been dated by the server (its `timestamp` IS its `createdAt`). A DM or
 * group row carries the server's receive time as `serverTimestamp` - `queued_message.createdAt` on a
 * recipient's copy, the `receivedAt` the send answered on the sender's own - and it is the same
 * value on every device, where `sentAt` is whatever the author's clock said when the bubble was
 * composed. A message delivered late (an outbox that held it for minutes, a clock that runs slow)
 * used to slot in ABOVE what everyone had already read, silently and already "read"; ordered by
 * this key it appears where it arrived. A row with no server time - a copy older than the field, a
 * history bundle from a source that lacked it - keeps its `sentAt`, the only date it has.
 *
 * Every consumer of "when" reads this one function - the sort, the read marks, the bubble's time,
 * the day separators, the conversation's recency - so none of them can disagree with another.
 */
export function messageTime(msg: DatedRow): number {
  const server = msg.serverTimestamp;
  if (typeof server === 'number' && Number.isFinite(server) && server > 0) return server;
  return stampedTime(msg);
}

/** The row's own stamped `timestamp` in ms: the author's `sentAt` for an MLS row, `createdAt` for a salon row. */
export function stampedTime(msg: Pick<DatedRow, 'timestamp'>): number {
  return msg.timestamp instanceof Date
    ? msg.timestamp.getTime()
    : new Date(msg.timestamp).getTime();
}

/**
 * How far BEFORE its author's own stamp a relayed server time may lie and still be believed: a
 * day, which covers any clock a phone keeps, and nothing a relayer could use to sink a message.
 */
export const BUNDLE_SERVER_TIME_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The `serverTimestamp` a HISTORY BUNDLE claims for one of its rows, or `undefined` when it cannot be
 * believed - and then the row keeps its `sentAt`, as a copy older than the field does.
 *
 * WHY IT IS VETTED. Since 2026-10-31 the server time IS the order key and the read-mark key
 * (`messageTime`), and a bundle row's value is written by its RELAYER, not by the server and not
 * signed by the author. A row dated 2100 would sort below everything for good and, read, push the
 * reader's server-clock mark to 2100 - every later message then "read" before it arrives.
 *
 * BOUNDED BY TWO FACTS THE RELAYER DOES NOT CONTROL. Above: the server's own time for the BUNDLE
 * frame (`queued_message.createdAt` on the live path, the history row's time on a replay) - every
 * message a bundle carries was accepted before the bundle was sent. Below: the row's `sentAt` (the
 * author's signed stamp when the row is proven) minus {@link BUNDLE_SERVER_TIME_SKEW_MS}. With no
 * server time for the frame there is no upper bound, so nothing is believed.
 */
export function vettedBundleServerTime(
  claimed: unknown,
  frameServerAt: number | undefined,
  sentAt: number | undefined
): number | undefined {
  if (typeof claimed !== 'number' || !Number.isFinite(claimed) || claimed <= 0) return undefined;
  if (!(typeof frameServerAt === 'number' && frameServerAt > 0) || claimed > frameServerAt) {
    return undefined;
  }
  if (
    typeof sentAt === 'number' &&
    Number.isFinite(sentAt) &&
    claimed < sentAt - BUNDLE_SERVER_TIME_SKEW_MS
  ) {
    return undefined;
  }
  return claimed;
}

/**
 * The second half of the vetting, once a row's signed bytes are VERIFIED: the lower bound again, on
 * the `sentAt` the author signed. {@link withVettedBundleServerTimes} can only read the relayer's
 * `timestamp`, which is as unsigned as the server time beside it - a relayer writing `1` in both
 * passed the first check (review of #2824, C). `undefined` when the claim falls below the signed
 * `sentAt` by more than {@link BUNDLE_SERVER_TIME_SKEW_MS}; the claim itself otherwise.
 */
export function boundedByVerifiedSentAt(
  serverTimestamp: number | undefined,
  verifiedSentAt: number
): number | undefined {
  if (serverTimestamp === undefined) return undefined;
  return serverTimestamp < verifiedSentAt - BUNDLE_SERVER_TIME_SKEW_MS
    ? undefined
    : serverTimestamp;
}

/**
 * Every row of a bundle through {@link vettedBundleServerTime}: a row whose claim cannot be believed
 * loses its `serverTimestamp` (and only that), a row with none is untouched. `dropped` counts the
 * claims refused, for the caller's log line.
 */
export function withVettedBundleServerTimes<
  T extends { serverTimestamp?: number; timestamp?: unknown },
>(rows: readonly T[], frameServerAt: number | undefined): { rows: T[]; dropped: number } {
  let dropped = 0;
  const out = rows.map((row) => {
    if (row.serverTimestamp === undefined) return row;
    const sentAt = typeof row.timestamp === 'number' ? row.timestamp : undefined;
    const kept = vettedBundleServerTime(row.serverTimestamp, frameServerAt, sentAt);
    if (kept !== undefined) return row;
    dropped++;
    const { serverTimestamp: _refused, ...rest } = row;
    return rest as T;
  });
  return { rows: out, dropped };
}
