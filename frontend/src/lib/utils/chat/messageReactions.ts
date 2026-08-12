import type { MessageReaction } from '$lib/types';

/**
 * Reactions as a convergent set: one entry per `(user, emoji)` pair, each carrying the time it last
 * changed state and whether it currently stands. The larger timestamp wins - that single rule makes
 * every operation here commutative, associative and idempotent, so two devices that have seen the
 * same frames in any order hold the same set, and a device that sees a frame twice is unchanged.
 *
 * The rule this replaces adopted a peer's reactions ONLY when the receiver held none, so a removal
 * never reached anyone holding a stale placement (D3 of
 * `docs/wiki/protocols/history-reconciliation.md`).
 *
 * The distinct-emoji cap is deliberately NOT enforced here. A frame that arrived is something the
 * group did, and a device that refused it would stay permanently different from one that accepted
 * it - the exact failure this file exists to remove. The cap belongs where the user ACTS, and is
 * applied by the send path through {@link canAddDistinctReactionEmoji}.
 */

/** Maximum number of distinct emoji types a user may place on a single message. */
export const MAX_DISTINCT_MESSAGE_REACTIONS = 15;

/** Key identifying the pair an entry is the state of. */
function pairKey(reaction: MessageReaction): string {
  return `${reaction.userId} ${reaction.emoji}`;
}

/** True when the entry represents a reaction that currently stands. */
export function isActiveReaction(reaction: MessageReaction): boolean {
  return reaction.removed !== true;
}

/** The reactions that currently stand - what the UI renders and what the cap counts. */
export function activeReactions(reactions: MessageReaction[]): MessageReaction[] {
  return reactions.filter(isActiveReaction);
}

export function countDistinctReactionEmojis(reactions: MessageReaction[]): number {
  return new Set(
    activeReactions(reactions)
      .map((r) => r.emoji)
      .filter(Boolean)
  ).size;
}

/** True if placing this emoji would introduce a new distinct type within the cap. */
export function canAddDistinctReactionEmoji(reactions: MessageReaction[], emoji: string): boolean {
  if (!emoji) return false;
  if (activeReactions(reactions).some((r) => r.emoji === emoji)) return true;
  return countDistinctReactionEmojis(reactions) < MAX_DISTINCT_MESSAGE_REACTIONS;
}

/** Normalise an entry from the wire or from disk: the user id is the pair's identity. */
function normalise(reaction: MessageReaction): MessageReaction {
  return { ...reaction, userId: reaction.userId.toLowerCase() };
}

/**
 * Apply one state change for a `(user, emoji)` pair, last-write-wins on `at`.
 *
 * Returns the new list, or `null` when the entry we hold is at least as recent - a frame delivered
 * twice, or one that lost the race. Callers use that null to skip the re-render and the write.
 *
 * Equal timestamps keep what we already hold: replaying a frame onto its own result must be a
 * no-op, not a flip, and "keep" is the only tie-break that needs no further rule.
 */
export function applyReaction(
  reactions: MessageReaction[],
  userId: string,
  emoji: string,
  at: number,
  removed = false
): MessageReaction[] | null {
  if (!emoji) return null;
  const next = normalise({ emoji, userId, at, removed });
  const key = pairKey(next);
  const index = reactions.findIndex((r) => pairKey(normalise(r)) === key);

  if (index === -1) {
    // A removal for a pair we never saw placed is still recorded: without it, a placement arriving
    // late afterwards would win on nothing but arrival order.
    return [...reactions, next];
  }
  if (at <= (reactions[index].at ?? 0)) return null;
  const merged = [...reactions];
  merged[index] = next;
  return merged;
}

/**
 * Merge a peer's reactions into ours, pair by pair, by the same last-write-wins rule.
 *
 * Returns `null` when the peer told us nothing new, so a bundle carrying reactions we already hold
 * costs no write. Taking the larger timestamp even when the state it carries matches ours is not
 * redundant: dropping it would make the result depend on the order the frames arrived in, which is
 * precisely what must not happen.
 */
export function mergeReactions(
  local: MessageReaction[],
  incoming: MessageReaction[]
): MessageReaction[] | null {
  const byPair = new Map(local.map((r) => [pairKey(normalise(r)), normalise(r)]));
  let changed = false;
  for (const candidate of incoming) {
    if (!candidate?.emoji || !candidate.userId) continue;
    const next = normalise(candidate);
    const current = byPair.get(pairKey(next));
    if (current && (next.at ?? 0) <= (current.at ?? 0)) continue;
    byPair.set(pairKey(next), next);
    changed = true;
  }
  return changed ? [...byPair.values()] : null;
}
