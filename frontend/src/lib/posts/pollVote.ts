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
