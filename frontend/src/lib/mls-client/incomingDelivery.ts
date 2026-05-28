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
