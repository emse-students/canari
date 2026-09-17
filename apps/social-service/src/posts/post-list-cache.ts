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
