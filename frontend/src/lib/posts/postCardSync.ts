import type { PostEntity } from '$lib/posts/api';

/**
 * The parts of a card the reader can change optimistically: each is written on the tap, before the
 * server answers, by `PostCard`'s reaction, vote and comment handlers.
 */
export type PostInteraction = 'reactions' | 'polls' | 'comments';

/** How many writes of each interaction are still waiting for the server on one card. */
export type InteractionsInFlight = Record<PostInteraction, number>;

/** A card with nothing in flight. */
export function noInteractionsInFlight(): InteractionsInFlight {
  return { reactions: 0, polls: 0, comments: 0 };
}

/**
 * What a card holds once its parent hands it a NEW served row for the same post.
 *
 * WHY IT EXISTS (review of #1896, 2026-10-15). `PostCard` copied its prop once, so a card drawn from
 * the feed's stored copy - no rights, `canVote: false`, yesterday's tallies - kept that copy for the
 * whole session when the server's page replaced the row: the keyed `{#each}` keeps the card, and the
 * new row never reached it. The served row now replaces the card's copy, EXCEPT the parts a write of
 * this reader is still carrying: a reaction, a vote or a comment sent before the row arrived. Their
 * own answers write the server's verdict when they land (or roll back that part only), so keeping the
 * optimistic value until then neither loses the tap nor outlives it.
 *
 * Everything else - the rights, the text, the pin, every other reader's reactions and votes - is the
 * served row's.
 */
export function adoptServedPost(
  local: PostEntity,
  served: PostEntity,
  inFlight: InteractionsInFlight
): PostEntity {
  const next: PostEntity = { ...served };
  if (inFlight.reactions > 0) next.reactions = local.reactions;
  if (inFlight.polls > 0) next.polls = local.polls;
  if (inFlight.comments > 0) next.comments = local.comments;
  return next;
}
