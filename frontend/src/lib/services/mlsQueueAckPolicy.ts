/**
 * Single source of truth for delivery-queue ACK rules (Web vs Tauri).
 *
 * Contract with `connection.ts`:
 * - Callback returns `false` → do not ACK (retry later).
 * - Callback throws on unexpected Welcome error → do not ACK (retry on reconnect).
 *
 * Intentional platform difference on **processing exceptions**:
 * - **Web**: only ACK **commits** on exception (app messages stay queued for retry).
 * - **Tauri**: ACK non-welcome messages on generic exception to avoid infinite loops
 *   (matches existing processQueue behavior); Welcome / GAP / UNRECOVERABLE never ACK.
 */

export type QueueMsgFlags = {
  isWelcome: boolean;
  isCommit: boolean;
  /** Present for messages originating from the persisted delivery queue */
  hasQueuedId: boolean;
};

export type QueuePlatform = 'web' | 'tauri';

/** After a successful `messageCallback` — ack only if callback did not request retry. */
export function shouldAckAfterSuccess(
  cbResult: boolean | undefined,
  flags: QueueMsgFlags
): boolean {
  return flags.hasQueuedId && cbResult !== false;
}

/** After successful processing of a persisted `group_reset` control row — always ack if we have an id. */
export function shouldAckGroupResetControl(flags: Pick<QueueMsgFlags, 'hasQueuedId'>): boolean {
  return flags.hasQueuedId;
}

/**
 * Web: exception in processQueue — ack commits only (idempotent); Welcome retries; app stays queued.
 */
export function shouldAckAfterWebException(flags: QueueMsgFlags): boolean {
  return flags.hasQueuedId && flags.isCommit;
}

/**
 * Tauri: exception in processQueue — narrow branches handled first by caller
 * (UNRECOVERABLE, GAP_QUEUED, Welcome). Remaining errors ack if queued id exists.
 */
export function shouldAckAfterTauriGenericException(flags: QueueMsgFlags): boolean {
  return flags.hasQueuedId;
}

export function isUnrecoverableError(errStr: string): boolean {
  return errStr.includes('UNRECOVERABLE:');
}

export function isGapQueuedError(errStr: string): boolean {
  return errStr.includes('GAP_QUEUED:');
}
