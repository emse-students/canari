import type { ChatMessage } from '$lib/types';

/** Returns the message timestamp as a numeric ms-since-epoch value regardless of input type. */
function messageTime(msg: ChatMessage): number {
  return msg.timestamp instanceof Date
    ? msg.timestamp.getTime()
    : new Date(msg.timestamp).getTime();
}

/**
 * Comparator for two messages: sorts by timestamp ascending, then by message ID
 * lexicographically to give a stable, deterministic order when timestamps collide.
 */
function compareMessageOrder(a: ChatMessage, b: ChatMessage): number {
  const t = messageTime(a) - messageTime(b);
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
}

/**
 * Returns a new array with `incoming` inserted at the correct chronological position.
 * Preserves the existing sort order without mutating the original array.
 */
export function insertMessageOrdered(
  messages: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] {
  const next = [...messages, incoming];
  next.sort(compareMessageOrder);
  return next;
}
