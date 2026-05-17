import type { ChatMessage } from '$lib/types';

/** Returns the message timestamp as a numeric ms-since-epoch value regardless of input type. */
function messageTime(msg: ChatMessage): number {
  return msg.timestamp instanceof Date
    ? msg.timestamp.getTime()
    : new Date(msg.timestamp).getTime();
}

/**
 * Comparator for two messages: timestamp ascending, then ingestSequence (MLS / catch-up
 * arrival order), then message id for a stable tie-break.
 */
export function compareMessageOrder(a: ChatMessage, b: ChatMessage): number {
  const t = messageTime(a) - messageTime(b);
  if (t !== 0) return t;
  const seqA = a.ingestSequence;
  const seqB = b.ingestSequence;
  if (seqA !== undefined && seqB !== undefined && seqA !== seqB) {
    return seqA - seqB;
  }
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

/**
 * Merges `incoming` into `existing` in array order (each item is inserted with
 * {@link insertMessageOrdered}). Use for batch catch-up so processing order is kept
 * when timestamps collide.
 */
export function mergeMessagesInInputOrder(
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  let merged = existing;
  for (const msg of incoming) {
    merged = insertMessageOrdered(merged, msg);
  }
  return merged;
}
