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
