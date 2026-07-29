import { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';

/**
 * Reactive emoji reactions for community channel messages, keyed by SERVER message id.
 *
 * Channels take the opposite route from DMs: a DM reaction is an encrypted MLS system message
 * replayed by every member, whereas a channel reaction is a cleartext server-side tally the
 * server has to count. So DM reactions live in `useMessaging.messageReactions` while these live
 * here, seeded from the message rows on channel open and refreshed by `channel.reaction` events.
 *
 * Not persisted - channels are server-authoritative and never stored locally.
 */
const reactionsByMessage = new SvelteMap<string, MessageReaction[]>();

/** Flattens the server tally (`emoji -> userIds`) into the flat list the UI renders. */
export function flattenReactionTally(
  tally: Record<string, string[]> | null | undefined
): MessageReaction[] {
  if (!tally) return [];
  const out: MessageReaction[] = [];
  for (const [emoji, userIds] of Object.entries(tally)) {
    if (!emoji || !Array.isArray(userIds)) continue;
    for (const userId of userIds) out.push({ emoji, userId: String(userId).toLowerCase() });
  }
  return out;
}

/** The reactions known for a channel message, or an empty list. */
export function getChannelReactions(messageId: string): MessageReaction[] {
  return reactionsByMessage.get(messageId) ?? [];
}

/** Replaces a message's tally with the authoritative server one (load or `channel.reaction`). */
export function setChannelReactions(
  messageId: string,
  tally: Record<string, string[]> | null | undefined
): void {
  if (!messageId) return;
  reactionsByMessage.set(messageId, flattenReactionTally(tally));
}

/**
 * Applies the caller's toggle optimistically so the pill reacts to the click without waiting for
 * the round trip. The server response (and the broadcast) then replaces it wholesale.
 */
export function applyLocalChannelReaction(messageId: string, userId: string, emoji: string): void {
  if (!messageId || !userId || !emoji) return;
  const userNorm = userId.toLowerCase();
  const current = reactionsByMessage.get(messageId) ?? [];
  const has = current.some((r) => r.userId === userNorm && r.emoji === emoji);
  reactionsByMessage.set(
    messageId,
    has
      ? current.filter((r) => !(r.userId === userNorm && r.emoji === emoji))
      : [...current, { emoji, userId: userNorm }]
  );
}

/**
 * The whole channel map, for the components that take a reaction map as a prop. Same instance
 * every call, so Svelte tracks it.
 */
export function channelReactionMap(): SvelteMap<string, MessageReaction[]> {
  return reactionsByMessage;
}
