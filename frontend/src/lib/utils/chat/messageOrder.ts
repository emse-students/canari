import type { ChatMessage } from '$lib/types';
import { parseEnvelope } from '$lib/envelope';

/** Returns the message timestamp as a numeric ms-since-epoch value regardless of input type. */
export function messageTime(msg: ChatMessage): number {
  return msg.timestamp instanceof Date
    ? msg.timestamp.getTime()
    : new Date(msg.timestamp).getTime();
}

/**
 * The sender id every system notice carries.
 *
 * This is the DURABLE form of "this row is a notice": `StoredMessage` has no `isSystem` column, so
 * a row read back from IndexedDB is recognised by this id and nothing else. `ChatMessage.isSystem`
 * is the DERIVED, in-memory form, and it is what the renderer reads.
 *
 * IT IS NOT A USER ID, so anything that resolves senders must refuse it rather than look it up:
 * `GET /api/users/system` was issued on every chat open and could only ever 404. That refusal lives
 * in `resolveDisplayNames`, which imports this constant instead of spelling it a second time.
 */
export const SYSTEM_SENDER_ID = 'system';

/**
 * Is this row a system notice?
 *
 * ONE BELIEF, ONE DERIVATION. `isSystem` and `senderId === SYSTEM_SENDER_ID` are the same fact in
 * two forms, and any writer that set one without the other produced a notice rendered as an
 * ORDINARY BUBBLE - labelled "Utilisateur", because no display name resolves for the sentinel and
 * the sender label falls back to the unknown-user string. The history bundle did exactly that: it
 * carries reactions, deletions, edits and the edit instant from the source device, and never
 * carried this flag, so a notice restored onto a second device arrived as a message from nobody.
 *
 * Every seam that MATERIALISES a row derives it from here instead of restating it, because an
 * invariant held in some of the places that build a row is not held.
 */
export function isSystemSender(senderId: string): boolean {
  return senderId.toLowerCase() === SYSTEM_SENDER_ID;
}

/**
 * Is this row a system notice (a device added, a member joined, a key rotated)?
 *
 * THE ONE TYPED PREDICATE, read by every consumer that must not treat a notice as conversation
 * activity (the sidebar recency, the `lastMessageAt` seed, the persisted `updatedAt`). `isSystem` is
 * the in-memory flag and the sender is the durable form; either one means a notice.
 */
export function isSystemRow(msg: Pick<ChatMessage, 'isSystem' | 'senderId'>): boolean {
  return msg.isSystem === true || isSystemSender(msg.senderId);
}

/**
 * Is this row a NOTICE - a system row that is not a call record?
 *
 * A call record (missed, ended, declined) is a product event that DOES count as activity, like on
 * Messenger and WhatsApp (decided 2026-10-27); it is a system row carrying a `callEvent` envelope.
 * Everything else sent by `system` (device added, member joined or left, key rotation) is a notice
 * and never moves a conversation. The envelope parse is cached.
 */
export function isNoticeRow(msg: Pick<ChatMessage, 'isSystem' | 'senderId' | 'content'>): boolean {
  if (!isSystemRow(msg)) return false;
  const env = parseEnvelope(msg.content);
  return !(env.kind === 'system' && env.callEvent);
}

/**
 * The `lastMessageAt` seed after `messages` arrived: it advances on REAL messages only.
 *
 * A system NOTICE is not activity (a call record is, see {@link isNoticeRow}), so it never moves the conversation up the list (user,
 * 2026-10-27). Every writer of the seed goes through here, so none can restate the rule.
 *
 * @param previous the seed before the arrival
 * @param messages the rows that arrived (or the merged row set - only the newest real one counts)
 */
export function advanceLastMessageAt(
  previous: number | undefined,
  messages: readonly Pick<ChatMessage, 'isSystem' | 'senderId' | 'timestamp' | 'content'>[]
): number | undefined {
  let next = previous;
  for (const msg of messages) {
    if (isNoticeRow(msg)) continue;
    const at = messageTime(msg as ChatMessage);
    if (Number.isFinite(at) && at > (next ?? 0)) next = at;
  }
  return next;
}

/**
 * The seed as a tab-sync event field: ABSENT when there is none, never `0` (a follower tab would
 * rank a conversation by 0, below its `startedAt`). Spread it into the event.
 */
export function tabSeed(seed: number | undefined): { lastMessageAt?: number } {
  return seed === undefined ? {} : { lastMessageAt: seed };
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
