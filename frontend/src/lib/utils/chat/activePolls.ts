import { parseEnvelope } from '$lib/envelope';
import { pollDeadlinePassed } from '$lib/posts/pollVote';
import type { ChannelPollMeta } from '$lib/services/ChannelService';

/** One poll of a salon thread as the "N active polls" shortcut needs it. */
export interface SalonPollEntry {
  /** The poll message's id - what a tap on the shortcut jumps to. */
  id: string;
  question: string;
  /**
   * The deadline that counts: the server's `endsAt` once its tally is known (a close stamps it
   * with the server's now), else the one written in the message. `null` = no deadline.
   */
  endsAt: string | null;
  /** The server's own "this poll is over" (`ChannelPollMeta.closed`), `false` before it spoke. */
  closed: boolean;
}

/**
 * Every poll message of a salon thread, oldest first, with the deadline and closure the SERVER
 * states for it when its tally is known.
 *
 * The shortcut used to read only the encrypted message, whose `endsAt` is the one chosen at
 * creation: a poll closed early by its author or a moderator has no such deadline (or a later
 * one), so it stayed counted as active for ever. The server's meta is where a close lands.
 *
 * @param messages The thread's messages; only `id` and `content` are read.
 * @param metaOf The live poll tally for a message id (`getPollMeta`), `undefined` when unknown.
 */
export function salonPolls(
  messages: readonly { id: string; content: string }[],
  metaOf: (messageId: string) => ChannelPollMeta | undefined
): SalonPollEntry[] {
  const out: SalonPollEntry[] = [];
  for (const message of messages) {
    const env = parseEnvelope(message.content);
    if (env.kind !== 'poll') continue;
    const meta = metaOf(message.id);
    out.push({
      id: message.id,
      question: env.question,
      endsAt: meta ? meta.endsAt : env.endsAt,
      closed: meta?.closed ?? false,
    });
  }
  return out;
}

/**
 * The polls still open at `at`: not closed by the server, and with no deadline behind `at`.
 *
 * `at` is an instant handed in (from `pollDeadlineClock`), never read from the wall clock here, so
 * the list changes exactly when a deadline arrives rather than at the next unrelated redraw.
 *
 * @param polls The thread's polls, from {@link salonPolls}.
 * @param at The instant to judge deadlines against, in epoch milliseconds.
 */
export function openSalonPolls(polls: readonly SalonPollEntry[], at: number): SalonPollEntry[] {
  return polls.filter((poll) => !poll.closed && !pollDeadlinePassed(poll.endsAt, at));
}
