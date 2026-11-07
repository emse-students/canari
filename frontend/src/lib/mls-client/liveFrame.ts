import { fromBase64 } from '$lib/utils/hex';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import type { MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/**
 * The queued message a LIVE MLS frame of the gateway becomes (`live_mls_frame`,
 * `apps/chat-gateway/src/subscribers.rs`), or `null` when it carries no ciphertext.
 *
 * ONE READER FOR BOTH SOCKETS (web and Tauri), because each field read here is read downstream as a
 * fact: `createdAt` becomes `queuedCreatedAt`, the server time a received `read_watermark` is
 * bounded by - a live frame that lost it had every read mark refused
 * (docs/wiki/frontend/modules/chat.md, "Conversations are ordered by the server's clock").
 * `channel` is left to `enqueueMessage`, which alone decides the route that counts.
 */
export function liveMlsFrameMessage(
  frame: Record<string, unknown>
): Omit<MlsQueuedMessage, 'channel' | 'type'> | null {
  if (typeof frame.proto !== 'string' || frame.proto.length === 0) return null;
  const ciphertext = fromBase64(frame.proto);
  if (ciphertext.length === 0) return null;
  const ratchetTreeBytes =
    typeof frame.ratchetTree === 'string' && frame.ratchetTree.length > 0
      ? fromBase64(frame.ratchetTree)
      : undefined;
  return {
    senderId: (frame.senderId as string) || 'unknown',
    senderDeviceId: (frame.senderDeviceId as string) || undefined,
    ciphertext,
    groupId: (frame.groupId as string) || undefined,
    isWelcome: frame.isWelcome === true,
    isCommit: frame.isCommit === true,
    ratchetTreeBytes,
    queuedMessageId: (frame.queuedMessageId as string) || undefined,
    queuedCreatedAt: parseServerTimestampMs(frame.createdAt),
    // Forwarded by the gateway since step A (history-answer-addressing, rule 4).
    addressed: frame.addressed === true,
  };
}
