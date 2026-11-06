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
 * `v3` (2026-11-04): the cached value became a STAMPED page ({@link readPostListPage}), a shape a
 * `v2` replica would serve as if it were the page itself during a rolling deploy - so the name moved
 * with the shape.
 */
export const POST_LIST_CACHE_PREFIX = 'posts:list:v3:';

/**
 * THE GENERATION OF THE WHOLE FEED CACHE. A sweep alone races the page it is meant to drop: a feed
 * read that computed its page BEFORE a write (a post hidden, deleted, made "Entre étudiants") and
 * stores it AFTER the sweep plants the old audience back for a whole TTL - and a sweep that failed
 * leaves it there too. So every invalidation first INCREMENTS this counter, every page is stored
 * with the generation it was computed under, and a page whose generation is not the current one is
 * never served: deterministic, whatever the interleaving, with the sweep left to reclaim memory.
 * Outside the prefix, so no sweep ever deletes it.
 *
 * NO TTL, ON THIS KEY OR ON A READER'S, DELIBERATELY. A counter that went back to 0 could match a
 * page still alive under the value it had before, so it must never vanish. Redis runs
 * `volatile-lru` on both estates, which evicts ONLY keys carrying a TTL: without one these are
 * never evicted, and AOF keeps them across a restart. A TTL would make them evictable, which is
 * the one way to reset them - `post-list-cache.spec.ts` asserts the policy in both compose files.
 * AOF `everysec` (the default fsync) can lose the last second of increments in a crash: a counter
 * that comes back one step behind serves again the pages stamped before the lost increment, at
 * most until their 30 s TTL - the bound the cache had before it had a generation.
 * The cost is one small integer per reader a member repost ever reached, bounded by the users.
 */
export const POST_LIST_GENERATION_KEY = 'posts:list:generation';

/** The generation of ONE reader's pages, moved by {@link invalidatePostListCacheFor}. */
function viewerGenerationKey(viewer: string | undefined): string {
  return `${POST_LIST_GENERATION_KEY}:${viewer ?? 'anon'}`;
}

/** What a page is stored as: the page, and the generations it was computed under. */
interface StampedPage {
  g: string;
  page: unknown;
}

/**
 * Reads one feed page and the stamp a page computed NOW must carry, in one round trip (`MGET` of
 * the two generations and the page). `page` is undefined on a miss, which includes a page stored
 * under an older generation: it was computed before an invalidation and may show a withdrawn post.
 */
export async function readPostListPage(
  redis: RedisService,
  key: string,
  viewer: string | undefined
): Promise<{ page: unknown; stamp: string }> {
  const [global, own, raw] = await redis.mget(
    POST_LIST_GENERATION_KEY,
    viewerGenerationKey(viewer),
    key
  );
  const stamp = `${global ?? '0'}.${own ?? '0'}`;
  if (!raw) return { page: undefined, stamp };
  const stored = JSON.parse(raw) as Partial<StampedPage> | null;
  return { page: stored?.g === stamp ? stored.page : undefined, stamp };
}

/** Stores a page under the stamp {@link readPostListPage} returned BEFORE it was computed. */
export async function writePostListPage(
  redis: RedisService,
  key: string,
  stamp: string,
  page: unknown,
  ttlSeconds: number
): Promise<void> {
  const stored: StampedPage = { g: stamp, page };
  await redis.setex(key, ttlSeconds, JSON.stringify(stored));
}

/** What one cached feed page is keyed by. */
export interface PostListCacheKeyParts {
  /** `all`, `followed`, `custom`, `associations` or `reels` - validated by the DTO, never a colon. */
  feed: string;
  viewerUserId: string | undefined;
  promo: number | undefined;
  formation: string | undefined;
  limit: number;
  offset: number;
  kind: string | undefined;
  /** The single-attachment posts the CanaReels list adds, or none (`full-screen-post-sql.ts`). */
  singleMedia: 'photos' | 'media' | undefined;
}

/**
 * The ONE spelling of a feed page's key. The viewer is the SECOND field, right after the feed, so
 * {@link invalidatePostListCacheFor} can read it back without guessing at the fields after it - which
 * is why the builder and that reader live side by side.
 */
export function postListCacheKey(p: PostListCacheKeyParts): string {
  return `${POST_LIST_CACHE_PREFIX}${p.feed}:${p.viewerUserId ?? 'anon'}:${p.promo ?? '-'}:${p.formation ?? '-'}:${p.limit}:${p.offset}:${p.kind ?? '-'}${p.singleMedia ? `+${p.singleMedia}` : ''}`;
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
 * THE GENERATION MOVES FIRST ({@link POST_LIST_GENERATION_KEY}), and that is what makes it
 * correct: from then on no page computed before this call is served, the one a concurrent read
 * stores after the sweep included. The sweep only reclaims memory, so its failure is harmless; a
 * failed INCREMENT throws, and the caller logs it - that alone can leave a stale page up to the TTL.
 */
export async function invalidatePostListCache(redis: RedisService): Promise<number> {
  await redis.incr(POST_LIST_GENERATION_KEY);
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
  // Their generations first, for the reason `invalidatePostListCache` gives.
  await redis.incrEach([...viewers].map(viewerGenerationKey));
  return redis.deleteMatching(`${POST_LIST_CACHE_PREFIX}*`, (key) => {
    const viewer = viewerOfPostListCacheKey(key);
    return viewer !== undefined && viewers.has(viewer);
  });
}
