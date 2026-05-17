import type { MessageReaction } from '$lib/types';

/** Maximum number of distinct emoji types allowed on a single message. */
export const MAX_DISTINCT_MESSAGE_REACTIONS = 15;

export function countDistinctReactionEmojis(reactions: MessageReaction[]): number {
  return new Set(reactions.map((r) => r.emoji).filter(Boolean)).size;
}

/** True if adding this emoji would introduce a new distinct type within the cap. */
export function canAddDistinctReactionEmoji(reactions: MessageReaction[], emoji: string): boolean {
  if (!emoji) return false;
  if (reactions.some((r) => r.emoji === emoji)) return true;
  return countDistinctReactionEmojis(reactions) < MAX_DISTINCT_MESSAGE_REACTIONS;
}

/**
 * Toggles a user's reaction on a message.
 * Returns null when adding a 16th distinct emoji type (limit reached).
 */
export function toggleMessageReaction(
  reactions: MessageReaction[],
  userId: string,
  emoji: string
): MessageReaction[] | null {
  if (!emoji) return null;

  const userNorm = userId.toLowerCase();
  const alreadyReacted = reactions.some((r) => r.userId === userNorm && r.emoji === emoji);

  if (alreadyReacted) {
    return reactions.filter((r) => !(r.userId === userNorm && r.emoji === emoji));
  }

  if (!canAddDistinctReactionEmoji(reactions, emoji)) {
    return null;
  }

  return [
    ...reactions.filter((r) => !(r.userId === userNorm && r.emoji === emoji)),
    { emoji, userId: userNorm },
  ];
}
