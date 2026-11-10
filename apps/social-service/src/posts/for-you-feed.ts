import type { RedisService } from '../common/redis/redis.service';

/**
 * POUR TOI (`feed=foryou`, owner, 2026-11-10): PEOPLE's posts only - what the people the reader
 * follows publish or repost (`forYouFollowedSql`) and the suggested posts of people (engagement WP-7,
 * `suggested-posts.ts`, `peopleOnly`) - ONE list ordered by freshness and popularity. An entity's
 * post (association, list, institution) is in Associations, never here. Campus (`all`) and Associations stay chronological
 * with their pins; Pour toi has no pin. The design and why each choice holds:
 * docs/wiki/frontend/modules/posts.md, "Pour toi - the ranked tab".
 *
 * THE LIST, as of an instant `asOf` (the database's clock when the first page was asked):
 *
 *   1. THE RANKED WINDOW - the candidates placed within {@link FOR_YOU_WINDOW_DAYS} days before
 *      `asOf` (at most {@link FOR_YOU_WINDOW_MAX}, the most recent), with the suggested posts,
 *      ordered by {@link forYouScoreSql}, then by placement, then by id (a total order);
 *   2. THE TAIL - the candidates placed before the window, newest first.
 *
 * DETERMINISTIC PAGING. A score moves with every reaction, and a reaction carries no date
 * (`posts.reactions` maps a reader to an emoji), so the engagement "as of" an instant cannot be read
 * back later: a ranking recomputed for page 2 would repeat or skip posts. The ranked window is
 * therefore computed ONCE, at the first page, and kept as a SNAPSHOT of ids under (reader, `asOf`)
 * ({@link ForYouSnapshot}); every later page names that `asOf` and is a slice of the snapshot, then
 * of the tail below its fixed boundary. Each served row carries `feedAsOf` and `feedPosition` (its
 * index in the whole list), and the client asks the next page from `feedPosition + 1` - so a row
 * the filters withdrew between two pages (deleted, hidden, blocked) shortens nothing and moves
 * nothing. A snapshot that is gone (its {@link RANKED_SNAPSHOT_TTL_SECONDS} lapsed with no page
 * read, or Redis lost it) ends the list: the next page is empty and the reader's refresh ranks anew.
 *
 * THE CANAREELS VIEWER IS RANKED THE SAME WAY (owner, 2026-11-10) when it asks `ranked=true`: its
 * candidates are every reel the reader may see (`feed=reels`), the same window, score, snapshot and
 * tail, and no suggestion. ONE score, ONE paging: `PostsService.listRankedRows`.
 */

/** How far back a followed post is RANKED, in days before `asOf`; older ones are the tail. */
export const FOR_YOU_WINDOW_DAYS = 14;
/** At most this many followed posts are ranked - the most recent of the window; the rest are the tail. */
export const FOR_YOU_WINDOW_MAX = 200;
/** The decay's exponent: how fast age outweighs engagement. */
export const FOR_YOU_GRAVITY = 1.5;
/** Hours added to every age, so a post a minute old does not divide by almost nothing. */
export const FOR_YOU_AGE_OFFSET_HOURS = 2;
/** How long a snapshot lives after its last read: a scroll left for longer starts again from the top. */
export const RANKED_SNAPSHOT_TTL_SECONDS = 2 * 60 * 60;

/** `asOf` as served and as accepted back: UTC, microseconds - the database's own precision. */
export const FOR_YOU_AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A `timestamptz` SQL expression spelled as {@link FOR_YOU_AS_OF_PATTERN}. */
export function forYouInstantTextSql(instant: string): string {
  return `to_char((${instant}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The uuid below every other: a boundary at an instant with it excludes that instant entirely. */
export const FOR_YOU_LOWEST_ID = '00000000-0000-0000-0000-000000000000';

/**
 * THE SCORE, ONE DEFINITION: `(1 + engaged) / (age in hours + 2) ^ 1.5`, the age read from `asOf`,
 * never from `now()`. `engaged` is `engagedAccountsSql` (the ONE popularity, WP-7 and WP-10's) and
 * `at` the instant the row is placed at (a republication or a followed repost refreshes it).
 *
 * Why this shape: it is the gravity rule news aggregators use - explainable in one line, monotone in
 * both terms (more engagement is never worse, older is never better), and with no constant learnt
 * from data the estate does not have. With these numbers a post an hour old with nobody engaged
 * (1/5.2 = 0.19) is above a day-old one with 10 accounts engaged (11/132.6 = 0.08), and that
 * day-old one is above a 3-day-old one with 20 (21/531 = 0.04): freshness leads, popularity
 * reorders within a day or two.
 */
export function forYouScoreSql(engaged: string, at: string, asOf: string): string {
  return `((1 + (${engaged}))::float8 / power(
      (GREATEST(EXTRACT(EPOCH FROM ((${asOf}) - (${at})))::float8 / 3600.0, 0) + ${FOR_YOU_AGE_OFFSET_HOURS})::float8,
      ${FOR_YOU_GRAVITY}::float8))`;
}

/**
 * Pour toi's LEAD (owner, 2026-11-10): a followed person's post placed less than this many hours
 * before `asOf` always comes first. "Not yet seen" was asked too, and the estate keeps no durable,
 * cheap fact of what a reader has seen - so the age alone decides, and no clock stands in for it.
 */
export const FOR_YOU_LEAD_HOURS = 48;

/**
 * POUR TOI'S BANDS, before the score (owner, 2026-11-10): 0 - a followed post placed within
 * {@link FOR_YOU_LEAD_HOURS} of `asOf`; 1 - a suggestion; 2 - every other followed post of the
 * window. The score orders each band. The product principle behind it: the reader finds what the
 * people they follow just published before anything else (docs/wiki/engagement.md, first section).
 */
export function forYouBandSql(suggested: string, at: string, asOf: string): string {
  return `(CASE WHEN ${suggested} THEN 1
               WHEN ${at} >= ${asOf} - make_interval(hours => ${FOR_YOU_LEAD_HOURS}) THEN 0
               ELSE 2 END)`;
}

/** The ranked window of one reader at one instant - what every later page is a slice of. */
export interface RankedSnapshot {
  asOf: string;
  /** The ranked window, best first. */
  ids: string[];
  /** Which of `ids` are suggestions (WP-7): served with `feedSuggested`, drawn with the badge. */
  suggested: string[];
  /** The tail is every followed post placed strictly below this (instant, id). */
  tailBefore: { at: string; id: string };
}

/**
 * Where a snapshot is kept: per list (`foryou`, or the CanaReels list with its mode), reader and
 * instant. Outside the feed cache's prefix: a feed invalidation does not drop it, and needs not - every
 * page re-reads its rows under the filters.
 */
export function rankedSnapshotKey(list: string, viewerId: string, asOf: string): string {
  return `posts:ranked:v1:${list}:${viewerId}:${asOf}`;
}

/** Stores a snapshot for {@link RANKED_SNAPSHOT_TTL_SECONDS}. */
export async function writeRankedSnapshot(
  redis: RedisService,
  list: string,
  viewerId: string,
  snapshot: RankedSnapshot
): Promise<void> {
  await redis.setex(
    rankedSnapshotKey(list, viewerId, snapshot.asOf),
    RANKED_SNAPSHOT_TTL_SECONDS,
    JSON.stringify(snapshot)
  );
}

/**
 * The snapshot of (reader, `asOf`), its lifetime renewed by the read, or null when it is gone. A
 * value that does not have the shape this module writes is null too - never a list half-read.
 */
export async function readRankedSnapshot(
  redis: RedisService,
  list: string,
  viewerId: string,
  asOf: string
): Promise<RankedSnapshot | null> {
  const key = rankedSnapshotKey(list, viewerId, asOf);
  const raw = await redis.get(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<RankedSnapshot> | null;
  if (
    !parsed ||
    parsed.asOf !== asOf ||
    !Array.isArray(parsed.ids) ||
    !Array.isArray(parsed.suggested) ||
    typeof parsed.tailBefore?.at !== 'string' ||
    typeof parsed.tailBefore?.id !== 'string'
  ) {
    return null;
  }
  await redis.setex(key, RANKED_SNAPSHOT_TTL_SECONDS, raw);
  return parsed as RankedSnapshot;
}

/** One ranked row as the rank query returns it. */
export interface ForYouRankedRow {
  id: string;
  /** {@link FOR_YOU_AS_OF_PATTERN}: fixed width, so two compare as strings. */
  at: string;
  suggested: boolean;
}

/**
 * The snapshot of a rank query's answer. The tail starts below the OLDEST followed row of a FULL
 * window (it held {@link FOR_YOU_WINDOW_MAX} rows, so older ones within the days were cut), else
 * below the window's first instant, `windowStart`.
 */
export function forYouSnapshotOf(
  asOf: string,
  windowStart: string,
  ranked: readonly ForYouRankedRow[]
): RankedSnapshot {
  const followed = ranked.filter((r) => !r.suggested);
  let tailBefore = { at: windowStart, id: FOR_YOU_LOWEST_ID };
  if (followed.length >= FOR_YOU_WINDOW_MAX) {
    const oldest = followed.reduce((a, b) =>
      b.at < a.at || (b.at === a.at && b.id < a.id) ? b : a
    );
    tailBefore = { at: oldest.at, id: oldest.id };
  }
  return {
    asOf,
    ids: ranked.map((r) => r.id),
    suggested: ranked.filter((r) => r.suggested).map((r) => r.id),
    tailBefore,
  };
}

/**
 * One page of the snapshot's slice: walking `ids` from `offset`, the rows that are still served
 * (`served`, the ids the filters let through now) until `limit`, each with its position in the whole
 * list. `tail` is what the tail owes the page: how many rows, from which offset of the tail - `null`
 * when the slice filled the page.
 */
export function forYouSlice<T>(input: {
  ids: readonly string[];
  offset: number;
  limit: number;
  served: ReadonlyMap<string, T>;
}): { rows: { row: T; position: number }[]; tail: { offset: number; limit: number } | null } {
  const { ids, offset, limit, served } = input;
  const rows: { row: T; position: number }[] = [];
  for (let i = offset; i < ids.length && rows.length < limit; i++) {
    const row = served.get(ids[i]);
    if (row !== undefined) rows.push({ row, position: i });
  }
  if (rows.length >= limit) return { rows, tail: null };
  return { rows, tail: { offset: Math.max(0, offset - ids.length), limit: limit - rows.length } };
}
