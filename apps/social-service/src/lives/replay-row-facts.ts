/**
 * WHAT A LIVE REPLAY'S POST ROW CARRIES BESIDE THE POST (docs/wiki/live-replays.md, WP-R4): the
 * cover and the server's clock, read when the row is SERVED - never stored with the post, never in
 * the feed's 30 s page cache.
 *
 * - THE COVER is the live's own last preview image (`lives."posterName"`, the one the open-lives card
 *   showed), with its POSTER key (`posterKeyOf`: HKDF of the live key, it opens that image and nothing
 *   else). No new object and no new key: the live row and its prefix are kept while the replay post
 *   exists (the purge waits for it), so the image is still where the card fetched it. A live that
 *   never stored a preview, or whose key does not open, has no cover - the card draws its dark box.
 * - `serverNow` is the database's `now()` at THIS read, the clock that wrote `expiresAt`: the client
 *   computes the time left from the two (`replayTimeLeft`), exactly as from the replay route's pair,
 *   so a phone with a skewed clock draws the right number. Read per serve and not cached: a cached
 *   page would carry a clock up to 30 s old.
 */
import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { storedLiveKeyColumns, type StoredLiveKey } from './live-key-at-rest';
import { posterKeyOf } from './live-poster-key';

const logger = new Logger('LiveReplayRow');

/** What one replay row gains when it is served. */
export interface ReplayRowFacts {
  /** The live's last preview image (`/api/media/public/live-poster/<liveId>/<name>`), or null. */
  poster: { name: string; ageMs: number } | null;
  /** The key that opens that image and nothing else; null whenever `poster` is. */
  posterKey: string | null;
  /** The database's clock at this read, to compare with `expiresAt` (D3). */
  serverNow: Date;
}

/**
 * The facts of the given lives' replays, by live id, in ONE query. A live id with no row left
 * (a broadcaster's erasure met it first) still answers its `serverNow`, with no cover.
 */
export async function readReplayRowFacts(
  manager: Pick<EntityManager, 'query'>,
  liveIds: readonly string[]
): Promise<Map<string, ReplayRowFacts>> {
  const ids = [...new Set(liveIds)];
  const facts = new Map<string, ReplayRowFacts>();
  if (ids.length === 0) return facts;
  const rows: (StoredLiveKey & {
    liveId: string;
    serverNow: Date;
    posterName: string | null;
    posterAgeMs: number | null;
  })[] = await manager.query(
    `SELECT ids.id::text AS "liveId", now() AS "serverNow", l."posterName",
            floor(extract(epoch FROM now() - l."posterAt") * 1000)::float8 AS "posterAgeMs",
            ${storedLiveKeyColumns('l')}
       FROM unnest($1::uuid[]) AS ids(id)
       LEFT JOIN lives l ON l.id = ids.id`,
    [ids]
  );
  for (const r of rows) {
    const {
      liveId,
      serverNow,
      posterName,
      posterAgeMs,
      liveKey,
      liveKeyCiphertext,
      liveKeyVersion,
    } = r;
    const posterKey =
      posterName !== null && posterName !== undefined
        ? posterKeyOf(liveId, { liveKey, liveKeyCiphertext, liveKeyVersion })
        : null;
    facts.set(liveId, {
      poster:
        posterName && posterKey !== null
          ? { name: posterName, ageMs: Math.max(0, Number(posterAgeMs)) }
          : null,
      posterKey: posterName && posterKey !== null ? posterKey : null,
      serverNow,
    });
  }
  logger.debug(
    `[LIVE_REPLAY] row facts for ${ids.length} replay(s): ${[...facts.values()].filter((f) => f.poster).length} with a cover`
  );
  return facts;
}
