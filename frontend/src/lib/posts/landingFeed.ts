import type { PostFeed } from './api';

/**
 * The feed a post lands in: `associations` for one made as an association, `all` for a personal
 * one, `null` for a scheduled one, which no feed shows until it is due.
 */
export function landingFeedFor(opts: {
  asAssociation: boolean;
  scheduled: boolean;
}): PostFeed | null {
  if (opts.scheduled) return null;
  return opts.asAssociation ? 'associations' : 'all';
}

/**
 * The feed to open after a publish, or `null` to stay where the reader is.
 *
 * A MEMBER WHO PUBLISHES MUST SEE THEIR POST. `all` shows everything, so a reader on it stays; a
 * reader on any other feed is taken to the one holding the post, instead of being handed back a
 * list that does not contain it (a personal post published from the Associations tab, Mi 9T,
 * 2026-10-05). The choice is never written to the reader's remembered tab: publishing is not a
 * preference.
 */
export function feedToShowAfterPublish(
  active: PostFeed,
  landing: PostFeed | null
): PostFeed | null {
  if (!landing || active === 'all' || active === landing) return null;
  return landing;
}
