import type { ChatMessage } from '$lib/types';
import { mkSystemEnvelope, serializeEnvelope } from '$lib/envelope';
import { chat_older_messages_unavailable } from '$lib/paraglide/messages';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';

/**
 * The notice a salon shows ONCE at the top of its history when rows written under a Graine v1
 * session this device does not hold were dropped from the load (channel-encryption section 21.7).
 *
 * Since `minClientVersion` reached the v2 writer an arriving v1 seed is refused, so a new member, a
 * new device without a backup, or a returner missing a v1 seed cannot read those rows, and nothing
 * asks a peer for them. Without a word the gap reads as a bug (user decision, 2026-10-12).
 *
 * DETERMINISTIC: derived from the load's own count of dropped rows, never from a timer. The id is
 * fixed per salon, so a reload merges into the same notice (`mergeMessagePage` keys by id) and the
 * salon never shows two. Timed 1 ms before the page's oldest row, so it sorts to the top.
 *
 * @param channelConversationId The salon (`channel_<uuid>`).
 * @param droppedV1Rows Rows of this load counted as `v1 session not held`.
 * @param oldestRowMs Server time of the page's oldest row, read or not.
 * @returns The notice, or null when no such row was dropped.
 */
export function olderMessagesNotice(
  channelConversationId: string,
  droppedV1Rows: number,
  oldestRowMs: number | undefined
): ChatMessage | null {
  if (droppedV1Rows <= 0 || oldestRowMs === undefined) return null;
  console.debug(
    `[CHANNEL] ${droppedV1Rows} v1 row(s) of ${channelConversationId.slice(0, 16)} not readable here - showing the older-messages notice`
  );
  return {
    id: olderMessagesNoticeId(channelConversationId),
    senderId: 'system',
    content: serializeEnvelope(mkSystemEnvelope(chat_older_messages_unavailable())),
    timestamp: new Date(oldestRowMs - 1),
    isOwn: false,
    isSystem: true,
  };
}

/** The notice's id: one per salon, so every load of that salon names the same notice. */
export function olderMessagesNoticeId(channelConversationId: string): string {
  return `graine-v1-unavailable:${channelConversationId}`;
}

/** The server time of a page's oldest row, read or not; undefined for a page with no dated row. */
export function oldestServerMs(rows: readonly { createdAt?: string | null }[]): number | undefined {
  let oldest: number | undefined;
  for (const row of rows) {
    const ms = parseServerTimestampMs(row.createdAt ?? undefined);
    if (ms !== undefined && (oldest === undefined || ms < oldest)) oldest = ms;
  }
  return oldest;
}
