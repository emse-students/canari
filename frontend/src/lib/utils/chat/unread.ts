import type { ChatMessage } from '$lib/types';

/**
 * Whether `msg` should still raise the unread badge for the user `meNorm`.
 *
 * The badge is never persisted (`ConversationMeta` carries no counter), so it is recomputed
 * every time a batch of messages lands. Both recompute sites used to infer "unseen" from
 * "arrived just now", which is only a proxy and breaks on a history bundle: those messages are
 * new to THIS device yet were already read on another one. They say so - the peer persisted our
 * read receipt and returns our own id in `readBy` inside the bundle - so the receipt is the
 * authority here, not the arrival time.
 *
 * @param msg Message to judge, already merged with any transport-carried read state.
 * @param meNorm Current user id, lowercased.
 */
export function isUnreadForUser(
  msg: Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'readBy'>,
  meNorm: string
): boolean {
  if (msg.isOwn || msg.isSystem || msg.senderId === 'system') return false;
  return !(msg.readBy ?? []).some((u) => u.toLowerCase() === meNorm);
}

/** Counts the messages of `msgs` that still read as unread for `meNorm`. */
export function countUnreadForUser(
  msgs: Array<Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'readBy'>>,
  meNorm: string
): number {
  return msgs.reduce((total, msg) => total + (isUnreadForUser(msg, meNorm) ? 1 : 0), 0);
}
