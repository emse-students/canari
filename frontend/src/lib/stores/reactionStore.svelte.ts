import { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';
import { applyReaction } from '$lib/utils/chat/messageReactions';

/**
 * Reactive emoji reactions for community channel messages, keyed by SERVER message id.
 *
 * **A channel reaction is an encrypted message now (WP-40), exactly like a DM one.** It used to be
 * a cleartext `emoji -> userIds` tally the server counted, which meant the server could not read
 * "j'arrive" but could still see that eight people put a heart on it - content, by any honest
 * reading. What travels instead is a `ReactionMsg` sealed under the sender's Graine session, and
 * this store is where the frames are merged.
 *
 * The merge is the SAME convergent rule the DM path uses (`applyReaction`, last-write-wins per
 * `(user, emoji)` pair on `at`), so two devices that saw the same frames in any order hold the same
 * set and a frame seen twice changes nothing.
 *
 * Not persisted - channels are server-authoritative and never stored locally.
 */
const reactionsByMessage = new SvelteMap<string, MessageReaction[]>();

/** The reactions known for a channel message, or an empty list. */
export function getChannelReactions(messageId: string): MessageReaction[] {
  return reactionsByMessage.get(messageId) ?? [];
}

/**
 * Merges one reaction frame - a placement or a removal - into what is held.
 *
 * @returns true when it changed something. A false is a frame that lost the last-write-wins race
 *   or is a replay, and it is not an error: it is what makes replaying a page of history free.
 */
export function applyChannelReactionFrame(
  messageId: string,
  userId: string,
  emoji: string,
  at: number,
  removed = false
): boolean {
  if (!messageId || !userId || !emoji) return false;
  const updated = applyReaction(getChannelReactions(messageId), userId, emoji, at, removed);
  if (!updated) return false;
  reactionsByMessage.set(messageId, updated);
  return true;
}

/**
 * The whole channel map, for the components that take a reaction map as a prop. Same instance
 * every call, so Svelte tracks it.
 */
export function channelReactionMap(): SvelteMap<string, MessageReaction[]> {
  return reactionsByMessage;
}
