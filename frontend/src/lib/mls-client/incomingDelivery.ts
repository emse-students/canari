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
  /**
   * The sender device the envelope names. Self-asserted by the sending client in its request body,
   * so it is compared with the verified credential, never believed (`verifiedSender`).
   */
  senderDeviceId?: string;
  /**
   * The route the ADMITTED copy took. `live` is the one that says something about the SENDER now:
   * the server pushed it the moment it was sent, so its sender was online seconds ago. A `pull`
   * copy is a queue row and may be hours old. Read by the overheard-pull retry
   * (`historyOverheardPull`), which needs exactly that proof.
   */
  channel?: DeliveryChannel;
  /**
   * The server routed this copy to this device alone rather than to the group
   * (`queued_message.addressed`). On a conversation such a frame is accepted only as a solicited,
   * bounded history answer - see `historyAddressing.ts`. Absent means a group broadcast.
   */
  addressed?: boolean;
};

/**
 * What the pipeline is told about how a queued frame ARRIVED, or `undefined` when nothing is known.
 * One place, because the route (`channel`) is read downstream as a proof - a field dropped here would
 * silently turn that proof off rather than fail.
 */
export function deliveryMetaOf(msg: {
  queuedCreatedAt?: number;
  queuedMessageId?: string;
  senderDeviceId?: string;
  channel?: DeliveryChannel;
  addressed?: boolean;
}): IncomingDeliveryMeta | undefined {
  const meta: IncomingDeliveryMeta = {
    ...(msg.channel ? { channel: msg.channel } : {}),
    ...(msg.addressed === true ? { addressed: true } : {}),
    ...(msg.queuedCreatedAt !== undefined ? { queuedCreatedAt: msg.queuedCreatedAt } : {}),
    ...(msg.queuedMessageId ? { queuedMessageId: msg.queuedMessageId } : {}),
    ...(msg.senderDeviceId ? { senderDeviceId: msg.senderDeviceId } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

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
