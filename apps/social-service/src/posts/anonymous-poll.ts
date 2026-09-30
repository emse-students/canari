/**
 * WHAT AN ANONYMOUS POLL STORES, AND WHAT A READER IS HANDED (user request, 2026-09-30).
 *
 * A named poll keeps `option.votes: string[]` and `votesByUser`, which is what lets a vote be
 * changed or retracted: the server knows the previous choice. Anonymity takes exactly that away, so
 * an anonymous poll is FINAL - one vote, no retraction, no change - and stores two things that
 * cannot be joined back to each other:
 *
 * - `option.votes: number`, a tally with no names; and
 * - `poll.voters: string[]`, who has voted and nothing about what, kept SORTED so the order of the
 *   list is not the order of arrival.
 *
 * `voters` is never served. Each reader gets `voted: boolean` about themselves instead, because a
 * list of participants is itself information about a poll the author promised was anonymous.
 */

/** A poll as stored, anonymous or not. The shape is open because the column is `jsonb`. */
export type StoredPoll = Record<string, any>;

/** True for a poll created anonymous. Read from the STORED value, never from a request. */
export function isAnonymousPoll(poll: StoredPoll | null | undefined): boolean {
  return poll?.anonymous === true;
}

/**
 * Records one vote on an anonymous poll, in place.
 *
 * @throws Error with `code` `EMPTY` or `REPEAT` so the caller can turn it into its own exception
 *   without this module depending on the HTTP layer.
 */
export function recordAnonymousVote(poll: StoredPoll, userId: string, optionIds: string[]): void {
  if (optionIds.length === 0) {
    throw Object.assign(new Error('An anonymous vote cannot be empty or retracted'), {
      code: 'EMPTY',
    });
  }
  const voters: string[] = Array.isArray(poll.voters) ? poll.voters : [];
  if (voters.includes(userId)) {
    throw Object.assign(new Error('You have already voted on this anonymous poll'), {
      code: 'REPEAT',
    });
  }
  for (const option of poll.options) {
    if (optionIds.includes(option.id)) {
      option.votes = (typeof option.votes === 'number' ? option.votes : 0) + 1;
    }
  }
  poll.voters = [...voters, userId].sort();
}

/**
 * The polls of a post as THIS reader may see them: an anonymous poll loses its voter list and
 * gains `voted`, everything else is passed through untouched.
 *
 * Applied at the two points every served post goes through, so a new read path cannot forget it
 * without also forgetting to shape the author.
 */
export function servePolls(polls: unknown, viewerId: string | undefined): unknown {
  if (!Array.isArray(polls)) return polls;
  return polls.map((poll: StoredPoll) => {
    if (!isAnonymousPoll(poll)) return poll;
    const { voters, ...rest } = poll;
    const list: string[] = Array.isArray(voters) ? voters : [];
    return { ...rest, votesByUser: {}, voted: !!viewerId && list.includes(viewerId) };
  });
}
