import type { RedisService } from '../common/redis/redis.service';

/**
 * THE FEED CACHE HAS ONE NAME AND ONE WAY TO THROW IT AWAY.
 *
 * Two services cache-bust the same keyspace, and until 2026-09-17 they disagreed about what it
 * contained. `AssociationsService` swept the whole prefix when an association's branding changed;
 * `PostsService` - the service that WRITES the posts - deleted eight literal keys, and every one of
 * them named the ANONYMOUS reader (`viewerUserId: undefined`) at offset 0 with one of four page
 * sizes. A signed-in reader's page has their own id in its key, so nothing on a create, a delete, a
 * pin or a moderation hide ever touched it: the author's own feed kept serving the previous answer
 * until the 30-second TTL ran out, which is a post that will not go away and a post that will not
 * appear.
 *
 * The prefix is the ONLY thing either caller needs to know, so it lives here rather than in the
 * service that happens to build the keys. A shared constant in a leaf module also keeps the two
 * services from importing each other - `PostsService` already depends on `AssociationsService`, and
 * the reverse edge would be a cycle.
 *
 * `v2` is deliberately unchanged: nothing about the cached SHAPE moved, only who remembers to
 * discard it. A version bump would orphan every live entry for no reader's benefit.
 */
export const POST_LIST_CACHE_PREFIX = 'posts:list:v2:';

/** What one cached feed page is keyed by. */
export interface PostListCacheKeyParts {
  /** `all`, `followed`, `custom` or `associations` - validated by the DTO, never a colon. */
  feed: string;
  viewerUserId: string | undefined;
  promo: number | undefined;
  formation: string | undefined;
  limit: number;
  offset: number;
  kind: string | undefined;
  singlePhotos: boolean;
}

/**
 * The ONE spelling of a feed page's key. The viewer is the SECOND field, right after the feed, so
 * {@link invalidatePostListCacheFor} can read it back without guessing at the fields after it - which
 * is why the builder and that reader live side by side.
 */
export function postListCacheKey(p: PostListCacheKeyParts): string {
  return `${POST_LIST_CACHE_PREFIX}${p.feed}:${p.viewerUserId ?? 'anon'}:${p.promo ?? '-'}:${p.formation ?? '-'}:${p.limit}:${p.offset}:${p.kind ?? '-'}${p.singlePhotos ? '+photos' : ''}`;
}

/** The viewer field of a key {@link postListCacheKey} built (`anon` for a signed-out page). */
function viewerOfPostListCacheKey(key: string): string | undefined {
  if (!key.startsWith(POST_LIST_CACHE_PREFIX)) return undefined;
  return key.slice(POST_LIST_CACHE_PREFIX.length).split(':')[1];
}

/**
 * Discards every cached feed page, for every reader.
 *
 * SCAN + DEL rather than an enumeration of likely keys, because the key carries the viewer, the
 * promo filter, the formation filter, the page size AND the offset - a literal list cannot cover
 * that product, and the one that tried covered 8 of it. It is called only when a post is written,
 * removed, pinned or hidden, and when an association's branding changes: a handful of times a day
 * against a keyspace of at most a few hundred entries, which is what `deleteByPattern`'s own
 * "use sparingly" is for.
 *
 * Non-fatal by construction: a feed that could not drop its cache serves a stale page for up to its
 * TTL, and failing the write that triggered it would be the worse outcome. The swallow is logged by
 * `deleteByPattern`'s caller-side catch, never silently.
 */
export async function invalidatePostListCache(redis: RedisService): Promise<number> {
  return redis.deleteByPattern(`${POST_LIST_CACHE_PREFIX}*`);
}

/**
 * Discards the cached feed pages of THESE readers only, every feed and page of theirs, and nobody
 * else's. For a write whose effect is bounded by a known set of readers - a member repost reaches
 * the reposter's accepted followers and changes the reposter's own card, and nobody else's page
 * (WP-F6) - so one person's repost does not throw away every reader's feed. One SCAN, like the full
 * sweep; what it spares is the recomputation of every other reader's pages.
 */
export async function invalidatePostListCacheFor(
  redis: RedisService,
  viewerIds: Iterable<string>
): Promise<number> {
  const viewers = new Set(viewerIds);
  if (viewers.size === 0) return 0;
  return redis.deleteMatching(`${POST_LIST_CACHE_PREFIX}*`, (key) => {
    const viewer = viewerOfPostListCacheKey(key);
    return viewer !== undefined && viewers.has(viewer);
  });
}
