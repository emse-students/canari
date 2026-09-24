import type { Poll, PostEntity } from '$lib/posts/api';

/**
 * WHAT A VOTE DOES TO A POLL, computed on the device that cast it.
 *
 * The tally is already complete locally - every poll carries `votesByUser` and a `votes[]` per
 * option - so there is nothing the server can add to the picture except confirmation. It was
 * applied AFTER `votePoll` answered anyway, which on a bad link is a reader tapping an option and
 * watching nothing happen for seconds. The channel-poll path had already reached the other
 * conclusion (`applyLocalVote` in `pollStore`, called before the server); this is the same
 * decision for the post-poll shape, extracted so it can be tested without a component.
 *
 * PURE, AND THEREFORE ROLLBACK-SAFE: the caller keeps the poll array it had and puts it back if
 * the write is refused.
 */
export function applyPostPollVote(
  post: PostEntity,
  pollId: string,
  userId: string,
  optionIds: string[]
): PostEntity {
  const polls = (post.polls ?? []).map((poll: Poll) => {
    if (poll.id !== pollId) return poll;

    const votesByUser = { ...poll.votesByUser };
    if (optionIds.length === 0) delete votesByUser[userId];
    else votesByUser[userId] = [...optionIds];

    const options = (poll.options ?? []).map((option) => {
      const votes = Array.isArray(option.votes) ? option.votes : [];
      const had = votes.includes(userId);
      const has = optionIds.includes(option.id);
      if (had && !has) return { ...option, votes: votes.filter((v) => v !== userId) };
      if (!had && has) return { ...option, votes: [...votes, userId] };
      return option;
    });

    return { ...poll, votesByUser, options };
  });

  return { ...post, polls };
}

/**
 * THE SELECTION A TAP PRODUCES, AND WHY IT IS NOT WRITTEN IN THE CARD.
 *
 * `PostCard.handleVoteClick` held this inline: single choice replaces, multiple choice toggles.
 * Adding a CAP to it - `maxSelections`, so an author can ask for "two of these five" - turns a
 * two-branch `if` into a rule with an edge nobody can see from a component, namely what a tap on a
 * sixth option does when five is the limit. It does nothing, and that has to be testable.
 *
 * **AND THE SERVER MUST NOT TRUST ANY OF IT.** Until 2026-09-23 `votePoll` recorded whatever
 * `optionIds` it was handed: `multipleChoice: false` was enforced by this function and by nothing
 * else, so a crafted request voted for every option of a single-choice poll. This is the
 * convenience half; `post-interactions.service.ts` is the half that decides.
 *
 * @param current The options already selected by this reader.
 * @param optionId The option just tapped.
 * @param poll The poll being voted on.
 * @returns The new selection, which may be `current` unchanged when the cap refuses the tap.
 */
export function nextPollSelection(
  current: string[],
  optionId: string,
  poll: Pick<Poll, 'multipleChoice' | 'maxSelections'>
): string[] {
  if (!poll.multipleChoice) {
    // Tapping the chosen option again clears the vote - the existing behaviour, kept: it is the
    // only way to withdraw from a single-choice poll.
    return current.includes(optionId) ? [] : [optionId];
  }
  if (current.includes(optionId)) return current.filter((id) => id !== optionId);
  const cap = poll.maxSelections ?? null;
  if (cap !== null && current.length >= cap) return current;
  return [...current, optionId];
}

/**
 * Whether one more option may be selected - what the card greys out, said once.
 *
 * @param current The options already selected.
 * @param poll The poll being voted on.
 * @returns `false` only when a cap is set and already reached.
 */
export function pollSelectionIsFull(
  current: string[],
  poll: Pick<Poll, 'multipleChoice' | 'maxSelections'>
): boolean {
  if (!poll.multipleChoice) return false;
  const cap = poll.maxSelections ?? null;
  return cap !== null && current.length >= cap;
}

/**
 * THE ONLY FIELD A DEADLINE NEEDS, AND WHY IT IS NOT `Pick<Poll, 'endsAt'>`.
 *
 * The two poll shapes spell the absent case differently - a post poll's `endsAt` is
 * `string | undefined`, a channel poll's `string | null` - and tying these helpers to either one
 * made the other a type error at the call site rather than at the seam. One optional field is all
 * they read, so that is what they ask for.
 */
export type PollDeadline = { endsAt?: string | null };

/**
 * HAS THIS POLL'S DEADLINE PASSED, AS OF AN INSTANT THE CALLER NAMES?
 *
 * The instant is a PARAMETER and not `Date.now()`, which is the whole point. `PostCard` spelt this
 * inline as `new Date(poll.endsAt).getTime() <= Date.now()`, read during render - so it answered
 * for the instant the card happened to be drawn and nothing ever re-ran it. A poll whose deadline
 * arrived while its card sat on screen kept showing the vote form until something unrelated forced
 * a redraw, and a reader could submit into a poll the server then refused with a 403.
 *
 * Naming the instant makes the staleness bounded and visible: {@link pollDeadlineClock} advances
 * it exactly when a deadline arrives, and nothing else moves it.
 *
 * @param endsAt The deadline the SERVER sent, or `null`/`undefined` for a poll that has none.
 * @param at The instant to judge against, in epoch milliseconds.
 * @returns `false` whenever there is no deadline - a poll without one never ends by itself.
 */
export function pollDeadlinePassed(endsAt: string | null | undefined, at: number): boolean {
  if (!endsAt) return false;
  const deadline = new Date(endsAt).getTime();
  return Number.isFinite(deadline) && deadline <= at;
}

/**
 * HOW LONG UNTIL THE NEXT DEADLINE ON THIS CARD ARRIVES - ONE TIMER, NOT ONE PER POLL.
 *
 * A card can carry several polls and the feed scrolls, so a timer per poll is a timer per poll per
 * card in a list: the thing the item behind this work explicitly refused. Only the EARLIEST
 * deadline still ahead is interesting, because when it arrives this runs again and finds the next.
 *
 * A deadline already behind `at` yields nothing: it needs no timer, since
 * {@link pollDeadlinePassed} already answers `true` for it. An unparseable date yields nothing
 * either, rather than a `NaN` delay that `setTimeout` would silently treat as zero and spin on.
 *
 * @param polls The polls on the card; only `endsAt` is read.
 * @param at The instant to measure from, in epoch milliseconds.
 * @returns Milliseconds until the earliest deadline strictly after `at`, or `undefined` when no
 *   poll has one - which is the signal to schedule nothing at all.
 */
export function msUntilPollDeadline(
  polls: readonly PollDeadline[],
  at: number
): number | undefined {
  let soonest: number | undefined;
  for (const poll of polls) {
    if (!poll.endsAt) continue;
    const deadline = new Date(poll.endsAt).getTime();
    if (!Number.isFinite(deadline) || deadline <= at) continue;
    if (soonest === undefined || deadline < soonest) soonest = deadline;
  }
  return soonest === undefined ? undefined : soonest - at;
}
