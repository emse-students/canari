import type { ChatMessage } from '$lib/types';
import { mkSystemEnvelope, serializeEnvelope } from '$lib/envelope';
import { chat_older_messages_unavailable } from '$lib/paraglide/messages';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { messageTime } from '$lib/utils/chat/messageOrder';

/** The fields of a server row the notice reads: its id, its date, and whether it is a silent row. */
export interface NoticeRow {
  id: string;
  createdAt?: string | null;
  silent?: boolean;
}

/**
 * The notice a salon shows ONCE at the top of its history when MESSAGES written under a Graine v1
 * session this device does not hold were dropped from the load (channel-encryption section 21.7).
 *
 * Since `minClientVersion` reached the v2 writer an arriving v1 seed is refused, so a new member, a
 * new device without a backup, or a returner missing a v1 seed cannot read those rows, and nothing
 * asks a peer for them. Without a word the gap reads as a bug (user decision, 2026-10-12).
 *
 * - DETERMINISTIC: derived from the load's own dropped rows, never from a timer.
 * - A SILENT row (a reaction or an edit, `silent` on the server row) is not counted: it never drew a
 *   bubble, so losing it leaves no gap to explain.
 * - The id is fixed per salon, so a reload merges into the same notice (`mergeMessagePage` keys by
 *   id) and the salon never shows two. It is timed before the page's oldest row; {@link
 *   keepNoticeOnTop} keeps it there once the page is merged with what was already held.
 *
 * @param channelConversationId The salon (`channel_<uuid>`).
 * @param rows The page as the server served it, read or not.
 * @param droppedV1RowIds Ids the load counted as `v1 session not held`.
 * @returns The notice, or null when no message row was dropped that way.
 */
export function olderMessagesNotice(
  channelConversationId: string,
  rows: readonly NoticeRow[],
  droppedV1RowIds: readonly string[]
): ChatMessage | null {
  if (droppedV1RowIds.length === 0) return null;
  const silent = new Set(rows.filter((r) => r.silent).map((r) => String(r.id)));
  const droppedMessages = droppedV1RowIds.filter((id) => !silent.has(id)).length;
  const oldest = oldestServerMs(rows);
  if (droppedMessages === 0 || oldest === undefined) return null;
  console.debug(
    `[CHANNEL] ${droppedMessages} v1 message(s) of ${channelConversationId.slice(0, 16)} not readable here - showing the older-messages notice`
  );
  return {
    id: olderMessagesNoticeId(channelConversationId),
    senderId: 'system',
    content: serializeEnvelope(mkSystemEnvelope(chat_older_messages_unavailable())),
    timestamp: new Date(oldest - 1),
    isOwn: false,
    isSystem: true,
  };
}

/**
 * Keeps the salon's notice FIRST once a page is merged with what was already held.
 *
 * The notice is timed before the oldest row of the page that made it, and a later page (a forced
 * reload, a search sweeping the whole history) can bring rows older than that - which would leave
 * the notice mid-history. Restamped 1 ms before the oldest other message instead. Returns the SAME
 * array when nothing moves, so a caller that compares identities rewrites nothing.
 */
export function keepNoticeOnTop(
  messages: ChatMessage[],
  channelConversationId: string
): ChatMessage[] {
  const id = olderMessagesNoticeId(channelConversationId);
  const at = messages.findIndex((m) => m.id === id);
  if (at === -1) return messages;
  const others = messages.filter((_, i) => i !== at);
  if (others.length === 0) return messages;
  const oldest = Math.min(...others.map(messageTime));
  const notice = messages[at];
  if (at === 0 && messageTime(notice) < oldest) return messages;
  return [{ ...notice, timestamp: new Date(oldest - 1) }, ...others];
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
