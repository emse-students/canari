import type { ChatMessage } from '$lib/types';

/** Returns the message timestamp as a numeric ms-since-epoch value regardless of input type. */
export function messageTime(msg: ChatMessage): number {
  return msg.timestamp instanceof Date
    ? msg.timestamp.getTime()
    : new Date(msg.timestamp).getTime();
}

/**
 * Comparator for two messages: timestamp ascending, then serverTimestamp (persistent server
 * queue order), then ingestSequence (in-session catch-up order), then message id as final tie-break.
 */
export function compareMessageOrder(a: ChatMessage, b: ChatMessage): number {
  const t = messageTime(a) - messageTime(b);
  if (t !== 0) return t;
  // Secondary: server queue time - persisted, survives reload.
  const stA = a.serverTimestamp;
  const stB = b.serverTimestamp;
  if (stA !== undefined && stB !== undefined && stA !== stB) {
    return stA - stB;
  }
  // Tertiary: in-session ingest order (only valid during current catch-up session).
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
 * Merges `incoming` into `existing` so the result is in {@link compareMessageOrder} order, with
 * messages that compare EQUAL kept in input order (existing first, then incoming as given). Use for
 * batch catch-up so processing order is kept when timestamps collide.
 *
 * ONE STABLE SORT, NOT ONE PER MESSAGE. This used to call {@link insertMessageOrdered} for each
 * incoming message - a copy and a full sort of the conversation per message, O(K x N) for a batch
 * of K into a thread of N (200 into 5000 measured 18-25 ms on a desktop, per batch). `Array.sort`
 * is stable, and a stable sort of `sort(A) ++ [x]` orders equal elements exactly as a stable sort
 * of `A ++ [x]` does, so the repeated sorts and the single one produce the same array - pinned
 * against the old loop on random input in the test.
 */
export function mergeMessagesInInputOrder(
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const merged = [...existing, ...incoming];
  merged.sort(compareMessageOrder);
  return merged;
}
