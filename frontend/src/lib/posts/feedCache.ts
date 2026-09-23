import type { PostEntity } from '$lib/posts/api';
import { currentUserId } from '$lib/stores/userState.svelte';
import type { PostFeed } from '$lib/posts/api';

/**
 * THE LAST PAGE EACH FEED TAB HELD, SO A TAB SWITCH PAINTS BEFORE IT ASKS.
 *
 * `routes/posts/+page.svelte` used to drop `postsOverride` and `initialPostsResolved` the instant
 * the URL changed, which is synchronous with the tap - so switching from "Associations" to "Tous"
 * and back replaced a feed that was already on screen with four pulsing skeletons and re-fetched
 * from zero. Under a shaped 1500 ms link that is seconds of nothing, for a list the device was
 * holding all along.
 *
 * WHAT MAKES STALE CONTENT SAFE HERE. A tab is only ever painted from ITS OWN last answer, never
 * from the tab being left, so the pill and the posts under it always agree. The fresh request goes
 * out in the same turn and replaces the entry when it lands.
 *
 * MEMORY ONLY, AND SCOPED TO ONE ACCOUNT. Posts are per-reader - `followed` and `promo` feeds are
 * literally so - so an entry carries the id it was fetched for and is invisible to anybody else;
 * a logout, which clears that id, therefore hides every entry without a sweep. It is not persisted
 * because a feed is the one thing that genuinely is stale after a reload.
 */
export interface FeedCacheEntry {
  posts: PostEntity[];
  hasMore: boolean;
}

export interface FeedCacheParams {
  feed: PostFeed;
  promo?: number;
  formation?: string;
}

/** The tabs a reader can reach, times the filters on them - a handful, and bounded by that. */
const MAX_ENTRIES = 12;

const entries = new Map<string, FeedCacheEntry>();

/** The key one tab's content is held under: the reader, then everything `load` resolved. */
export function feedCacheKey(params: FeedCacheParams): string {
  return [currentUserId() ?? '', params.feed, params.promo ?? '', params.formation ?? ''].join('|');
}

/** The last page this tab held for this reader, or `null` if it has never been loaded here. */
export function readFeedCache(key: string): FeedCacheEntry | null {
  return entries.get(key) ?? null;
}

/** Records what a tab now holds, evicting the oldest entry once the map is full. */
export function writeFeedCache(key: string, entry: FeedCacheEntry): void {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Drops everything. Exported for the tests, which must not inherit each other's entries. */
export function clearFeedCache(): void {
  entries.clear();
}
