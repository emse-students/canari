/**
 * Which of the two channels handed a delivery to the queue.
 *
 * THE SEAM THAT DEDUPLICATES DELIVERIES CANNOT DERIVE THIS, and it used to guess. A repeat was
 * reported as "the live frame and the pull crossed" whichever way round it had actually happened -
 * a sentence that is true of one shape, plausible for a second, and an accusation misdirected for
 * the other two. The four combinations of channel and prior state mean four different things, one
 * of them a server defect, and telling them apart is the whole reason the line is printed at all
 * (see `BaseMlsService.admitDelivery`). Both call sites know which they are; carrying it one frame
 * down is cheaper than inferring it from a log nobody can classify.
 */
export type DeliveryChannel = 'live' | 'pull';

/** Metadata for an MLS payload delivered via the offline queue (not live WebSocket). */
export type IncomingDeliveryMeta = {
  /** Server `queued_message.createdAt` in ms - when the message was enqueued for this device. */
  queuedCreatedAt?: number;
  /** Server queue row id - stable dedup key when the MLS payload has no `messageId`. */
  queuedMessageId?: string;
};

/**
 * Parses a server-side timestamp (queue `createdAt`, Redis history, WS envelope).
 * Accepts ISO strings or Unix epoch ms; rejects zero/invalid values.
 */
export function parseServerTimestampMs(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) && t > 0 ? t : undefined;
  }
  return undefined;
}

/** @deprecated Prefer {@link parseServerTimestampMs}. */
export const parseQueuedCreatedAt = parseServerTimestampMs;

/**
 * A repeat, named by WHO offered the second copy and WHAT this device had already done with it.
 *
 * The four combinations are not four spellings of one event: three are crossings nothing can
 * prevent, and `live:done` is the only one no crossing explains - the socket publishes once, at
 * send, and never replays the queue on connect. Keeping them apart as a type is what lets the
 * counters be per shape, which is what makes their rate mean anything.
 */
export type DeliveryRepeatShape = `${DeliveryChannel}:${'queued' | 'done'}`;
