/** Metadata for an MLS payload delivered via the offline queue (not live WebSocket). */
export type IncomingDeliveryMeta = {
  /** Server `queued_message.createdAt` in ms — when the message was enqueued for this device. */
  queuedCreatedAt?: number;
  /** Server queue row id — stable dedup key when the MLS payload has no `messageId`. */
  queuedMessageId?: string;
};

/** Parses `createdAt` from a pending-queue API row (ISO string or epoch ms). */
export function parseQueuedCreatedAt(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}
