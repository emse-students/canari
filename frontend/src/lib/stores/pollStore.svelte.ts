import { SvelteMap } from 'svelte/reactivity';
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import { Log } from '$lib/utils/Log';

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

/**
 * WHAT EACH TALLY IS AS OF, on one counter - never a clock. A live write (a `channel.poll.vote`
 * event, a poll arriving live, a vote's answer, an optimistic vote) takes the next value; a page's
 * write takes the value its request left at (`pollWriteMark`). A tally carries no version of its
 * own, and a page is decoded for seconds - or, for a row waiting for its seed, for as long as a
 * key-group drain lasts - so a page written after a live vote rewound it to the tally fetched
 * before. The overlap is the write order; this names it: a page never writes over a tally written
 * after its request left.
 */
let pollWrites = 0;
const pollAsOf = new SvelteMap<string, number>();

/** Returns the live poll meta for a message, or undefined if none is known yet. */
export function getPollMeta(messageId: string): ChannelPollMeta | undefined {
  return polls.get(messageId);
}

/** Stores/replaces the poll meta for a message from a LIVE source (an event, a vote's answer). */
export function setPollMeta(messageId: string, meta: ChannelPollMeta): void {
  if (!messageId) return;
  pollWrites += 1;
  pollAsOf.set(messageId, pollWrites);
  polls.set(messageId, meta);
}

/** The mark a page's request leaves at: what its tallies will be as of. Read BEFORE the request. */
export function pollWriteMark(): number {
  return pollWrites;
}

/**
 * Stores a poll meta read from a server PAGE whose request left at `mark` - unless a write made
 * after that (a live vote, a newer page) holds it already, which the page cannot have seen.
 */
export function setPollMetaFromPage(messageId: string, meta: ChannelPollMeta, mark: number): void {
  if (!messageId) return;
  if ((pollAsOf.get(messageId) ?? -1) > mark) {
    Log.d(
      'POLL',
      `page tally of ${messageId.slice(0, 8)} older than a live write - kept the live one`
    );
    return;
  }
  pollAsOf.set(messageId, mark);
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
  setPollMeta(messageId, { ...meta, votesByUser });
}
