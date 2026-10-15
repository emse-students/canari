import { getContext, hasContext, setContext } from 'svelte';
import { listPosts, type ListPostsOptions, type PostEntity } from '$lib/posts/api';

/**
 * WHERE THE REEL VIEWER'S NEXT REELS COME FROM (CanaReels filter, 2026-10-15).
 *
 * Opened from the feed filtered to CanaReels, the viewer must swipe through THAT list - the reels of
 * the tab the reader is on, after the one touched - not every reel of `feed=all`. The feed page sets
 * this context while it filters; the viewer reads it at mount. Anywhere else (a chat, a post page,
 * the unfiltered feed) there is no source and the viewer keeps its C7 list. Decisions:
 * docs/wiki/frontend/modules/reels.md, "The CanaReels filter".
 */
export interface ReelFeedSource {
  /** The filtered feed's query (tab, promo, formation), or `null` while the feed is not filtered. */
  options: () => Omit<ListPostsOptions, 'offset' | 'limit' | 'kind'> | null;
}

/** A page of reels from `offset`, `limit` long - what `ReelViewer` asks for. */
export type ReelPageLoader = (offset: number, limit: number) => Promise<PostEntity[]>;

const KEY = Symbol('reel-feed-source');

/** Declares the filtered feed as the source of the viewer's reels, for the components under it. */
export function setReelFeedSource(source: ReelFeedSource): void {
  setContext(KEY, source);
}

/** The source set above this component, or `undefined`. Called at component initialisation. */
export function getReelFeedSource(): ReelFeedSource | undefined {
  return hasContext(KEY) ? getContext<ReelFeedSource>(KEY) : undefined;
}

/** The C7 list: every live reel the reader may see, newest first. */
const ALL_REELS: ReelPageLoader = (offset, limit) =>
  listPosts({ kind: 'reel', feed: 'all', offset, limit });

/**
 * The page loader the viewer opened on `startPost` uses.
 *
 * With a filtered feed, the reels after the touched one are read by a CURSOR, its `publishedAt`:
 * the server has none to offer (`GET /api/posts` pages by offset only), so this loader walks the
 * filtered tab from its top with its OWN offset and keeps the reels published at or before the
 * touched one. Where the touched reel sits in the list on screen decides nothing, so reels published
 * since, or rows deleted above it, cannot shift where the viewer continues. The viewer's `offset` is
 * ignored; a page shorter than `limit` means the list has ended. One limit is the offset paging
 * itself: a reel deleted between two page reads shifts the rest by one, as in the feed's own scroll.
 * Without a filtered feed, the C7 list.
 */
export function reelPageLoader(
  source: ReelFeedSource | undefined,
  startPost: Pick<PostEntity, 'id' | 'publishedAt'>
): ReelPageLoader {
  const options = source?.options() ?? null;
  if (!options) return ALL_REELS;
  const cursor = Date.parse(startPost.publishedAt);
  let serverOffset = 0;
  let ended = false;
  console.debug(
    `[reel-viewer] paging the filtered feed "${options.feed}" from ${startPost.publishedAt}`
  );
  return async (_offset, limit) => {
    const kept: PostEntity[] = [];
    while (kept.length < limit && !ended) {
      const page = await listPosts({ ...options, kind: 'reel', offset: serverOffset, limit });
      serverOffset += page.length;
      if (page.length < limit) ended = true;
      for (const reel of page) {
        if (reel.id !== startPost.id && Date.parse(reel.publishedAt) <= cursor) kept.push(reel);
      }
    }
    return kept;
  };
}
