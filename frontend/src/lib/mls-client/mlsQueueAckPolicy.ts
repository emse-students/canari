/**
 * Single source of truth for delivery-queue ACK rules (Web and Tauri).
 *
 * Contract with `connection.ts`:
 * - Callback returns `false` → do not ACK (retry later).
 * - Callback throws on unexpected Welcome error → do not ACK (retry on reconnect).
 *
 * ACK policy on **processing exceptions** (both platforms):
 * - Only ACK **commits** on exception (idempotent); Welcome retries on reconnect;
 *   application messages stay queued for retry.
 */

export type QueueMsgFlags = {
  isWelcome: boolean;
  isCommit: boolean;
  /** Present for messages originating from the persisted delivery queue */
  hasQueuedId: boolean;
};

/** After a successful `messageCallback` - ack only if callback did not request retry. */
export function shouldAckAfterSuccess(
  cbResult: boolean | undefined,
  flags: QueueMsgFlags
): boolean {
  return flags.hasQueuedId && cbResult !== false;
}

/** After successful processing of a persisted `group_reset` control row - always ack if we have an id. */
export function shouldAckGroupResetControl(flags: Pick<QueueMsgFlags, 'hasQueuedId'>): boolean {
  return flags.hasQueuedId;
}

/**
 * Exception in processQueue - ACK commits only (idempotent); Welcome retries on reconnect;
 * application messages stay queued. Applies to both Web and Tauri.
 */
export function shouldAckAfterException(flags: QueueMsgFlags): boolean {
  return flags.hasQueuedId && flags.isCommit;
}
