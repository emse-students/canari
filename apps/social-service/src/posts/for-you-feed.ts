import type { RedisService } from '../common/redis/redis.service';

/**
 * POUR TOI (`feed=foryou`, owner, 2026-11-10): what PEOPLE the reader follows write or repost
 * (`forYouFollowedSql` - an entity's post a followed person reposted included, with its "X a
 * repartage" header) and the suggested posts of people (engagement WP-7, `suggested-posts.ts`,
 * `peopleOnly`) - ONE list ordered by freshness and popularity. An entity's post nobody followed
 * reposted is in Associations, never here. Campus (`all`) and Associations stay chronological with
 * their pins; Pour toi has no pin. The design and why each choice holds:
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
 * ({@link RankedSnapshot}); every later page names that `asOf` and is a slice of the snapshot, then
 * of the tail below its fixed boundary. Each served row carries `feedAsOf` and `feedPosition` (its
 * index in the whole list), and the client asks the next page from `feedPosition + 1` - so a row
 * the filters withdrew between two pages (deleted, hidden, blocked) shortens nothing and moves
 * nothing. THE TAIL is paged by a keyset (`feedCursor`, the last tail row's placement and id), never
 * an offset, excludes every id of the snapshot, and counts a followed repost only if made by `asOf`:
 * a row withdrawn or a repost written between two pages skips nothing and repeats nothing.
 *
 * A snapshot that is gone ({@link RANKED_SNAPSHOT_TTL_SECONDS} with no page, pushed out by
 * {@link RANKED_SNAPSHOTS_KEPT} newer ones, or lost by Redis) is ANSWERED `410 RANKING_GONE`, and a
 * Redis that does not answer `503 RANKING_UNAVAILABLE` - never an empty page the client would read as
 * the end of the list. The client ranks anew on the 410 and offers a retry on the 503.
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
/**
 * How long a reader's snapshots live after the last read or write of any of them (one key per list
 * and reader): a scroll left for longer is answered 410 and ranked anew.
 */
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
  /** The ranked window, best first, each post once. */
  ids: string[];
  /** Which of `ids` are suggestions (WP-7): served with `feedSuggested`, drawn with the badge. */
  suggested: string[];
  /** The tail is every candidate placed strictly below this (instant, id), not in `ids`. */
  tailBefore: { at: string; id: string };
}

/**
 * The refusals of a ranked list, each its own status and stable code, so the client reads the
 * answer and never a sentence (`apiRefusalError.ts`):
 *
 * - `RANKING_GONE` (410): the snapshot a page names is gone - its 2 h lapsed with no page, it was
 *   pushed out by {@link RANKED_SNAPSHOTS_KEPT} newer ones, or Redis lost it. The client ranks anew
 *   and appends only what it has not shown.
 * - `RANKING_UNAVAILABLE` (503): Redis did not answer the read or the write. A first page whose
 *   snapshot could not be kept is never served: its page 2 would have nothing to be a slice of.
 * - `RANKING_PAGE_INVALID` (400): a later page without the `asOf` of its ranking, or a tail cursor
 *   where the window is not finished - the client mixed two shapes of one list.
 */
export const RANKING_GONE = 'RANKING_GONE';
export const RANKING_UNAVAILABLE = 'RANKING_UNAVAILABLE';
export const RANKING_PAGE_INVALID = 'RANKING_PAGE_INVALID';

/**
 * How many snapshots one reader keeps per list: the latest, by `asOf`. A bound on what a reader can
 * make Redis hold (one key per list and reader, at most this many fields), whatever they refresh.
 * Three covers a refresh while an older scroll is still being read, and the first-page sizes the
 * feed asks (`FEED_FIRST_PAGE_SIZE`, then a refresh).
 */
export const RANKED_SNAPSHOTS_KEPT = 3;

/**
 * Where a reader's snapshots of one list are kept: ONE hash, a field per `asOf`. The list name
 * carries everything that changes the candidates (feed, kind, the single-media mode, replays), so
 * two lists never share a snapshot. Outside the feed cache's prefix: a feed invalidation does not
 * drop it, and needs not - every page re-reads its rows under the filters.
 */
export function rankedSnapshotKey(list: string, viewerId: string): string {
  return `posts:ranked:v2:${list}:${viewerId}`;
}

/**
 * WRITE: the snapshot under its `asOf`, the fields beyond the newest {@link RANKED_SNAPSHOTS_KEPT}
 * dropped (an `asOf` is fixed width, so its byte order is its time order), the key's lifetime set -
 * one atomic step. Returns how many were dropped.
 */
export const RANKED_SNAPSHOT_WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
local fields = redis.call('HKEYS', KEYS[1])
table.sort(fields)
local excess = #fields - tonumber(ARGV[3])
for i = 1, excess do redis.call('HDEL', KEYS[1], fields[i]) end
redis.call('EXPIRE', KEYS[1], ARGV[4])
if excess < 0 then return 0 end
return excess`;

/** READ: the snapshot of one `asOf`, the key's lifetime renewed (`EXPIRE`, never a rewrite) when found. */
export const RANKED_SNAPSHOT_READ_SCRIPT = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if v then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return v`;

/** Stores a snapshot, keeping the reader's newest {@link RANKED_SNAPSHOTS_KEPT}. Throws on a Redis failure. */
export async function writeRankedSnapshot(
  redis: RedisService,
  list: string,
  viewerId: string,
  snapshot: RankedSnapshot
): Promise<number> {
  const dropped = await redis.evalScript(
    RANKED_SNAPSHOT_WRITE_SCRIPT,
    [rankedSnapshotKey(list, viewerId)],
    [snapshot.asOf, JSON.stringify(snapshot), RANKED_SNAPSHOTS_KEPT, RANKED_SNAPSHOT_TTL_SECONDS]
  );
  return Number(dropped) || 0;
}

/**
 * The snapshot of (list, reader, `asOf`), its lifetime renewed by the read, or null when it is gone.
 * A value that does not have the shape this module writes is null too - never a list half-read.
 * Throws on a Redis failure: "gone" and "not answered" are two answers.
 */
export async function readRankedSnapshot(
  redis: RedisService,
  list: string,
  viewerId: string,
  asOf: string
): Promise<RankedSnapshot | null> {
  const raw = await redis.evalScript(
    RANKED_SNAPSHOT_READ_SCRIPT,
    [rankedSnapshotKey(list, viewerId)],
    [asOf, RANKED_SNAPSHOT_TTL_SECONDS]
  );
  if (typeof raw !== 'string' || raw === '') return null;
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
 * The snapshot of a rank query's answer. The tail starts below the OLDEST candidate row of a FULL
 * window (it held `windowMax` candidates, so older ones within the days were cut), else below the
 * window's first instant, `windowStart`.
 */
export function forYouSnapshotOf(
  asOf: string,
  windowStart: string,
  ranked: readonly ForYouRankedRow[],
  windowMax: number = FOR_YOU_WINDOW_MAX
): RankedSnapshot {
  const followed = ranked.filter((r) => !r.suggested);
  let tailBefore = { at: windowStart, id: FOR_YOU_LOWEST_ID };
  if (followed.length >= windowMax) {
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
 * THE TAIL'S CURSOR: the (placement instant, id) of the last tail row served, which the next page
 * reads below - a keyset, never an OFFSET, so a tail row withdrawn between two pages shifts nothing.
 * Served on every tail row as `feedCursor`, asked back as `cursor`.
 */
export const FOR_YOU_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The cursor of a tail row placed at `at` ({@link FOR_YOU_AS_OF_PATTERN}). */
export function forYouCursorOf(at: string, id: string): string {
  return `${at}_${id}`;
}

/** The (instant, id) a cursor names; it matched {@link FOR_YOU_CURSOR_PATTERN} at the controller. */
export function parseForYouCursor(cursor: string): { at: string; id: string } {
  const cut = cursor.indexOf('_');
  return { at: cursor.slice(0, cut), id: cursor.slice(cut + 1) };
}

/**
 * One page of the snapshot's slice: walking `ids` from `offset`, the ids still served (`served`, the
 * ids the filters let through now) until `limit`, each with its position in the whole list. `tail`
 * is how many rows the tail owes the page - `null` when the slice filled it.
 */
export function forYouSlice(input: {
  ids: readonly string[];
  offset: number;
  limit: number;
  served: ReadonlySet<string>;
}): { picks: { id: string; position: number }[]; tail: number | null } {
  const { ids, offset, limit, served } = input;
  const picks: { id: string; position: number }[] = [];
  for (let i = offset; i < ids.length && picks.length < limit; i++) {
    if (served.has(ids[i])) picks.push({ id: ids[i], position: i });
  }
  return { picks, tail: picks.length >= limit ? null : limit - picks.length };
}
