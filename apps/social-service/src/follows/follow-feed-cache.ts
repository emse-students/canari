import type { Logger } from '@nestjs/common';
import type { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCacheFor } from '../posts/post-list-cache';

/**
 * Discards the cached feed pages of ONE reader after a follow of theirs began or ended (`reason`,
 * for the log line): what they follow decides their own pages and nobody else's, so nobody else's
 * are thrown away. Without it the reader's feed keeps the previous answer for the cache's 30 s - a
 * person just unfollowed still there, an association just followed still missing - and a control
 * that appears not to have worked is one people press again.
 *
 * Best-effort and loud: the follow row is already written and every by-id read already follows it;
 * a cache that could not be dropped serves a stale page for its TTL, which failing the write would
 * not fix.
 */
export async function dropFeedPagesOfReader(
  redis: RedisService,
  logger: Logger,
  reader: string,
  reason: string
): Promise<void> {
  try {
    const dropped = await invalidatePostListCacheFor(redis, [reader]);
    logger.debug(
      `[FOLLOW] feed pages of ${reader.slice(0, 8)} dropped after ${reason}: ${dropped}`
    );
  } catch (e) {
    logger.warn(
      `[FOLLOW] feed pages of ${reader.slice(0, 8)} not dropped after ${reason}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
