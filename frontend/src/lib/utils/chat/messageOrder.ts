import type { ChatMessage } from '$lib/types';
import { parseEnvelope } from '$lib/envelope';

import { messageTime, stampedTime } from './messageTime';

export { messageTime, stampedTime } from './messageTime';

/** {@link messageTime} as a `Date`, for what draws it (the bubble's time, the day separators). */
export function messageDate(msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp'>): Date {
  return new Date(messageTime(msg));
}

/**
 * Is this the author's own copy of a message the server has not dated YET?
 *
 * A salon echo before its row settles (`awaitingServerId`), or an own DM/group row still unsent -
 * queued, in flight, failed or unanswered - with no `serverTimestamp`. It has no place in the shared
 * timeline until the server gives it one, so it is drawn BELOW every dated row (the salon echo was
 * always pinned there) and takes its place when the send answers `receivedAt`
 * ({@link replaceMessageOrdered}). An own row whose status is gone (`undefined`, `sent`) and that
 * still has no server time is a copy older than the field: it keeps its `sentAt`, never the bottom,
 * or every message sent before this change would sink below the conversation for ever.
 */
export function awaitsServerTime(
  msg: Pick<ChatMessage, 'isOwn' | 'status' | 'serverTimestamp' | 'awaitingServerId'>
): boolean {
  if (msg.awaitingServerId === true) return true;
  if (!msg.isOwn || msg.serverTimestamp !== undefined) return false;
  return (
    msg.status === 'pending' ||
    msg.status === 'sending' ||
    msg.status === 'error' ||
    msg.status === 'unconfirmed'
  );
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
 * A system NOTICE is not activity (a call record is, see {@link isNoticeRow}), so it never moves
 * the conversation up the list (user, 2026-10-27). Every writer of the seed goes through here, so none can restate the rule.
 *
 * @param previous the seed before the arrival
 * @param messages the rows that arrived (or the merged row set - only the newest real one counts)
 */
export function advanceLastMessageAt(
  previous: number | undefined,
  messages: readonly Pick<
    ChatMessage,
    'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp' | 'content'
  >[]
): number | undefined {
  let next = previous;
  for (const msg of messages) {
    if (isNoticeRow(msg)) continue;
    const at = messageTime(msg);
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
 * THE ORDER OF A CONVERSATION: one key per row, so the order is total and transitive.
 *
 * 1. Rows the server has dated (or that can never be, see {@link awaitsServerTime}) come first,
 *    ordered by {@link messageTime}; the author's own rows still awaiting their server time come
 *    after ALL of them, ordered among themselves by their `sentAt`.
 * 2. Equal keys fall to the message id, by codepoint, so every device breaks a tie the same way.
 *
 * NOTHING ELSE IS READ. The comparator used to rank by `sentAt`, then by `serverTimestamp`, then by
 * the in-session `ingestSequence` - each a tie-break used only when BOTH rows had it, which made it
 * intransitive on a mixed population (a < b < c < a), so the order of a conversation depended on
 * the order its rows happened to arrive in (chat.md, "One stable sort"). A lexicographic order on
 * (tier, key, id) has no such cycle.
 */
export function compareMessageOrder(a: ChatMessage, b: ChatMessage): number {
  const tierA = awaitsServerTime(a) ? 1 : 0;
  const tierB = awaitsServerTime(b) ? 1 : 0;
  if (tierA !== tierB) return tierA - tierB;
  const t = messageTime(a) - messageTime(b);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * `messages` with the row at `idx` replaced by `updated` and moved to where its key now puts it -
 * for a patch that can change the key: a send answering `receivedAt`, a row leaving or entering the
 * "awaiting its server time" tier. Returns the same order as a full sort; it only skips the sort
 * when the row is still between its neighbours, which is nearly always.
 */
export function replaceMessageOrdered(
  messages: ChatMessage[],
  idx: number,
  updated: ChatMessage
): ChatMessage[] {
  const next = [...messages];
  next[idx] = updated;
  const before = idx > 0 ? next[idx - 1] : undefined;
  const after = idx < next.length - 1 ? next[idx + 1] : undefined;
  const inPlace =
    (!before || compareMessageOrder(before, updated) <= 0) &&
    (!after || compareMessageOrder(updated, after) <= 0);
  if (!inPlace) next.sort(compareMessageOrder);
  return next;
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

/**
 * `sentAt=… serverAt=… gap=…ms` for an inbound row - the author's stamp, the server's acceptance and
 * the distance between them, which is the one number that tells a message the network or an outbox
 * HELD (gap of minutes, both on the server's side of the clock) from a sender whose clock is wrong
 * (a gap that is negative, or the same on every message of that sender). `serverAt=none` for a row
 * the server did not date, which is then ordered by its `sentAt`.
 */
export function clockGapNote(msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp'>): string {
  const sent = stampedTime(msg);
  const server = msg.serverTimestamp;
  const sentIso = Number.isFinite(sent) ? new Date(sent).toISOString() : 'none';
  if (typeof server !== 'number' || !Number.isFinite(server) || server <= 0) {
    return `sentAt=${sentIso} serverAt=none`;
  }
  return `sentAt=${sentIso} serverAt=${new Date(server).toISOString()} gap=${server - sent}ms`;
}

/**
 * The row of `msgs` whose server time is furthest after its `sentAt`, for a batch's one log line:
 * `largest gap …` or `''` when no row carries both clocks.
 */
export function largestClockGapNote(
  msgs: ReadonlyArray<Pick<ChatMessage, 'id' | 'timestamp' | 'serverTimestamp'>>
): string {
  let worst: (typeof msgs)[number] | null = null;
  let worstGap = -Infinity;
  for (const m of msgs) {
    if (typeof m.serverTimestamp !== 'number' || !(m.serverTimestamp > 0)) continue;
    const gap = m.serverTimestamp - stampedTime(m);
    if (gap > worstGap) {
      worstGap = gap;
      worst = m;
    }
  }
  return worst ? ` - largest gap ${worst.id.slice(0, 8)}… ${clockGapNote(worst)}` : '';
}
