import type { PostKind } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';

/**
 * THE CANAREELS FILTER AT THE TOP OF THE FEED (user, 2026-10-15) - a VIEW on the feed, not a place.
 *
 * C7 stands: there is no Reels tab in any bar. The feed gains a two-way choice, "Tout" or
 * "CanaReels", which narrows whichever tab is open to its reels. The SERVER does the narrowing
 * (`GET /api/posts?kind=reel`): filtering a paginated feed on the device gives empty pages.
 * Decisions: docs/wiki/frontend/modules/reels.md, "The CanaReels filter".
 */

/** The two views of the feed: everything, or its reels only. */
export const FEED_KIND_FILTERS = ['all', 'reel'] as const;

export type FeedKindFilter = (typeof FEED_KIND_FILTERS)[number];

/** Where the last choice is kept - a per-viewer convenience, never a record. */
const STORAGE_KEY = 'canari_post_feed_kind';

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
 * The filter this viewer last chose, or `null`. Storage may be absent or throw (a private window,
 * blocked site data): the feed then opens unfiltered, logged.
 */
export function readPreferredFeedKind(): FeedKindFilter | null {
  try {
    return parseFeedKindFilter(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch (error) {
    Log.d('POSTS', `the remembered feed filter could not be read: ${String(error)}`);
    return null;
  }
}

/** Remembers the filter for this viewer's next visit; a storage that refuses is logged, not fatal. */
export function rememberFeedKind(filter: FeedKindFilter): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, filter);
  } catch (error) {
    Log.d('POSTS', `the feed filter could not be remembered: ${String(error)}`);
  }
}

/**
 * The filter `load` resolves: the URL wins (a shared `?kind=reel`), then the remembered choice,
 * then the whole feed - the same order as the tab itself.
 */
export function resolveFeedKind(urlValue: string | null): FeedKindFilter {
  return parseFeedKindFilter(urlValue) ?? readPreferredFeedKind() ?? 'all';
}
