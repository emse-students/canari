import { SvelteMap } from 'svelte/reactivity';
import type { ChannelPollMeta } from '$lib/services/ChannelService';

/**
 * Reactive live tally for community polls, keyed by message id.
 *
 * The poll's question and option labels live (end-to-end encrypted) in the
 * message envelope; only the mutable vote state lives here. It is seeded from
 * the server on channel open / message receive and updated by `channel.poll.vote`
 * gateway events and optimistic local votes. Not persisted: it is always
 * re-fetched from the authoritative server tally.
 */
const polls = new SvelteMap<string, ChannelPollMeta>();

/** Returns the live poll meta for a message, or undefined if none is known yet. */
export function getPollMeta(messageId: string): ChannelPollMeta | undefined {
  return polls.get(messageId);
}

/** Stores/replaces the authoritative poll meta for a message (server load or event). */
export function setPollMeta(messageId: string, meta: ChannelPollMeta): void {
  if (!messageId) return;
  polls.set(messageId, meta);
}

/**
 * Applies a local vote optimistically: clears the user's previous selection then
 * sets the new one (empty = retract). A subsequent server event reconciles it.
 */
export function applyLocalVote(messageId: string, userId: string, optionIds: string[]): void {
  const meta = polls.get(messageId);
  if (!meta || !userId) return;
  const votesByUser = { ...meta.votesByUser };
  if (optionIds.length === 0) delete votesByUser[userId];
  else votesByUser[userId] = [...optionIds];
  polls.set(messageId, { ...meta, votesByUser });
}
