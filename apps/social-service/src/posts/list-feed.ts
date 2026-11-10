import type { PostKind } from './reel.constants';

/**
 * The values `GET /api/posts?feed=` accepts. The TABS of the feed: `all` is "Campus" ("Mon espace"
 * until 1.6.9), `foryou` is "Pour toi" (ranked, `for-you-feed.ts`), `associations`, and the
 * promo/formation browse `custom`. `followed` is the chronological "Suivis" that Pour toi replaced
 * in 1.6.9, kept unchanged for installed clients (docs/wiki/legacy-compatibility.md). `reels` is NOT a
 * tab: it is the CanaReels viewer's list (docs/wiki/frontend/modules/reels.md, "The CanaReels
 * entry", point 3) - every reel the reader may see, the union of the three tabs, read with the WHOLE
 * visibility predicate (`postVisibleToViewerSql`, no disjunct turned off).
 */
export const LIST_POST_FEEDS = [
  'all',
  'followed',
  'foryou',
  'custom',
  'associations',
  'reels',
] as const;

/** One of {@link LIST_POST_FEEDS}. */
export type ListPostsFeed = (typeof LIST_POST_FEEDS)[number];

/** What a list request resolves to: the feed the service runs, and whether a legacy shape asked it. */
export interface ResolvedListFeed {
  feed: ListPostsFeed;
  /** True when an installed client's `kind=reel` with no feed (or `all`) was read as `reels`. */
  legacyViewerShape: boolean;
}

/**
 * Reads the feed a list request asks for, `all` when it names none.
 *
 * LEGACY SHIM (docs/wiki/legacy-compatibility.md, "`feed=all&kind=reel` read as the viewer list"):
 * every installed client up to 1.6.x asks the viewer's list as `kind=reel` with NO `feed` (the client
 * drops `feed=all` from the URL), which used to run the "Mon espace" arm - filtered by spaces, so a
 * reel the reader may see only as an accepted follower, or through a member repost, never reached
 * the viewer. Since 1.2.9 no tab sends `kind` (the filtered-feed mode was deleted, reels.md point 5),
 * so `kind=reel` on `all` is the viewer and nothing else: it is read as `reels`.
 */
export function resolveListFeed(
  feed: ListPostsFeed | undefined,
  kind: PostKind | undefined
): ResolvedListFeed {
  const asked = feed ?? 'all';
  if (asked === 'all' && kind === 'reel') return { feed: 'reels', legacyViewerShape: true };
  return { feed: asked, legacyViewerShape: false };
}

/** What `PostsService.listPosts` is asked: one page of one feed, for one reader. */
export interface ListPostsParams {
  limit: number;
  offset: number;
  feed: ListPostsFeed;
  viewerUserId?: string;
  isAdmin?: boolean;
  promo?: number;
  formation?: string;
  /** Restricts the page to one kind; absent means posts AND reels. Always `reel` on `reels`. */
  kind?: PostKind;
  /** With `kind: 'reel'`, the posts whose only content is ONE picture come too (`full-screen-post-sql.ts`). */
  singlePhotos?: boolean;
  /** With `kind: 'reel'`, the posts whose only content is ONE picture OR ONE video come too; wins over `singlePhotos`. */
  singleMedia?: boolean;
  /** With `kind: 'reel'`, the posts of 2..10 pictures and videos come too, with the single ones; wins over both. */
  multiMedia?: boolean;
  /** With `multiMedia`, a post with a link in its text comes too. */
  withLinks?: boolean;
  /** A live replay comes too; never without it (docs/wiki/live-replays.md). */
  withReplays?: boolean;
  /** The CanaReels viewer only: ranked like Pour toi (`for-you-feed.ts`) rather than newest first. */
  ranked?: boolean;
  /** A ranked list only: the ranking a later page is a slice of (`for-you-feed.ts`); absent ranks anew. */
  asOf?: string;
}

/** The kind a page is narrowed to: `reel` on the viewer's list whatever was asked, else the request's. */
export function listKind(params: Pick<ListPostsParams, 'feed' | 'kind'>): PostKind | undefined {
  return params.feed === 'reels' ? 'reel' : params.kind;
}
