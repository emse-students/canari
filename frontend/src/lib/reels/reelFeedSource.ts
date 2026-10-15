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
  /** The filtered list on screen, so the viewer pages on from the touched reel's position. */
  list: () => readonly Pick<PostEntity, 'id'>[];
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
 * The page loader the viewer opened on `startPostId` uses.
 *
 * With a filtered feed, the server is asked for `kind=reel` on the SAME tab, from the touched reel's
 * index in the list on screen: the server pages the same list, so the reels after it come next (the
 * touched one, answered again, is dropped by `mergeReelPage`). A reel the list does not hold starts
 * at the top. Without a filtered feed, the C7 list.
 */
export function reelPageLoader(
  source: ReelFeedSource | undefined,
  startPostId: string
): ReelPageLoader {
  const options = source?.options() ?? null;
  if (!source || !options) return ALL_REELS;
  const start = Math.max(
    0,
    source.list().findIndex((p) => p.id === startPostId)
  );
  console.debug(`[reel-viewer] paging the filtered feed "${options.feed}" from ${start}`);
  return (offset, limit) => listPosts({ ...options, kind: 'reel', offset: start + offset, limit });
}
