import type { ListPostsOptions, PostFeed, PostKind } from '$lib/posts/api';
import { feedToShowAfterPublish } from '$lib/posts/landingFeed';
import { Log } from '$lib/utils/Log';

/**
 * THE CANAREELS FILTER AT THE TOP OF THE FEED (user, 2026-10-15) - a VIEW on the feed, not a place.
 *
 * C7 stands: there is no Reels tab in any bar. The feed gains a two-way choice, "Tous les posts" or
 * "CanaReels", which narrows whichever tab is open to its reels. The SERVER does the narrowing
 * (`GET /api/posts?kind=reel`): filtering a paginated feed on the device gives empty pages.
 * Decisions: docs/wiki/frontend/modules/reels.md, "The CanaReels filter".
 */

/** The two views of the feed: everything, or its reels only. */
export const FEED_KIND_FILTERS = ['all', 'reel'] as const;

export type FeedKindFilter = (typeof FEED_KIND_FILTERS)[number];

/** Where the last choice is kept across launches - a per-viewer convenience, never a record. */
const STORAGE_KEY = 'canari_post_feed_kind';

/**
 * The choice made in THIS session, whatever the storage did with it. A storage that read fine but
 * refused the write would otherwise answer the stale value, and a choice would seem to do nothing.
 */
let sessionChoice: FeedKindFilter | null = null;

/**
 * Narrows an outside string (`?kind=`, a stored choice) to a filter, or `null` when it names none -
 * NOT the default, so `load` can fall through the URL to the remembered choice.
 */
export function parseFeedKindFilter(value: string | null | undefined): FeedKindFilter | null {
  return FEED_KIND_FILTERS.includes(value as FeedKindFilter) ? (value as FeedKindFilter) : null;
}

/** The `kind` the feed request carries for a filter: `reel`, or nothing for the whole feed. */
export function feedKindParam(filter: FeedKindFilter): PostKind | undefined {
  return filter === 'reel' ? 'reel' : undefined;
}

/** The filter a resolved `kind` stands for - the inverse of {@link feedKindParam}. */
export function feedKindFilterOf(kind: PostKind | undefined): FeedKindFilter {
  return kind === 'reel' ? 'reel' : 'all';
}

/**
 * The filter this viewer chose: this session's choice first, then the stored one, or `null`.
 * Storage may be absent or throw (a private window, blocked site data): logged, and `null`.
 */
export function readPreferredFeedKind(): FeedKindFilter | null {
  if (sessionChoice) return sessionChoice;
  try {
    return parseFeedKindFilter(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch (error) {
    Log.d('POSTS', `the remembered feed filter could not be read: ${String(error)}`);
    return null;
  }
}

/** Remembers the filter for this session and, when storage allows, the next launch. */
export function rememberFeedKind(filter: FeedKindFilter): void {
  sessionChoice = filter;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, filter);
  } catch (error) {
    Log.d('POSTS', `the feed filter could not be remembered: ${String(error)}`);
  }
}

/** Forgets this session's choice. For the tests, which must not inherit each other's choice. */
export function resetFeedKindSession(): void {
  sessionChoice = null;
}

/**
 * The filter `load` resolves: the URL wins (a shared `?kind=reel`), then the remembered choice,
 * then the whole feed - the same order as the tab itself.
 */
export function resolveFeedKind(urlValue: string | null): FeedKindFilter {
  return parseFeedKindFilter(urlValue) ?? readPreferredFeedKind() ?? 'all';
}

/** What `load` resolved, as the page and every request after it read it. */
export interface FeedParams {
  feed: PostFeed;
  promo?: number;
  formation?: string;
  kind?: PostKind;
}

/**
 * The query of one page of the feed: exactly what the first page asked, `kind` included, at
 * `offset`. The infinite scroll and the refresh both read it, so no page drops the filter.
 */
export function feedPageOptions(
  params: FeedParams,
  offset: number,
  limit: number
): ListPostsOptions {
  return { limit, offset, ...params };
}

/**
 * The "new" mark after posts published at `seen` came into view. It measures the WHOLE feed: a reel
 * seen in the CanaReels view says nothing of the posts published between, so that view leaves it.
 */
export function advanceLastSeen(
  current: number,
  seen: readonly number[],
  filter: FeedKindFilter
): number {
  if (filter === 'reel') return current;
  return seen.reduce((max, ts) => (ts > max ? ts : max), current);
}

/**
 * The `kind` a tab switch writes into the URL: the viewer's CHOICE ({@link readPreferredFeedKind}),
 * so a `kind` written by a publish lasts for that visit only. With no choice ever made, the URL's
 * own `kind` (a shared link) is kept: `null`.
 */
export function kindForTabSwitch(): FeedKindFilter | null {
  return readPreferredFeedKind();
}

/** Where the feed goes after a publish, or `null` to stay and refresh. */
export interface PublishLanding {
  feed: PostFeed;
  /** Written into the URL for this visit only, never remembered. */
  kind?: FeedKindFilter;
}

/**
 * Where a publish lands. A post is not a reel, so publishing while filtered shows the WHOLE feed
 * (`kind=all`, this visit only); otherwise the tab rule of {@link feedToShowAfterPublish}.
 */
export function landingAfterPublish(
  activeFeed: PostFeed,
  activeKind: FeedKindFilter,
  landing: PostFeed | null
): PublishLanding | null {
  const target = feedToShowAfterPublish(activeFeed, landing);
  if (activeKind === 'reel') return { feed: target ?? activeFeed, kind: 'all' };
  return target ? { feed: target } : null;
}
