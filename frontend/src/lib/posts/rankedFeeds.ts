import type { PostEntity } from './api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { Log } from '$lib/utils/Log';

/**
 * THE PAGES OF A RANKED LIST (Pour toi and the CanaReels viewer, owner 2026-11-10;
 * `apps/social-service/src/posts/for-you-feed.ts`). A ranked list is a SNAPSHOT the server took at
 * its first page: every row it serves names that snapshot (`feedAsOf`), its own place in the whole
 * list (`feedPosition`) and, below the ranked window, its keyset (`feedCursor`). The next page is
 * asked after the last place served, of the same snapshot, below the last tail row - never from the
 * number of rows on screen, which a row withdrawn between two pages would shift.
 */

/**
 * Whether `rows` were served in the shape of the list `feed` names: a page of Pour toi carries the
 * ranking facts on every row (`feedAsOf`); one without them was the old `followed` list - another
 * list, associations included - and must never be kept or drawn as Pour toi (alpha.6, 2026-11-10).
 * THE SHAPE FOLLOWS THE ESTATE: `rankedEstate` is `false` only when the estate SAYS it serves no
 * ranked list (`rankedFeeds: false`), and there the `followed` rows are the documented fallback
 * page, kept as served. Unknown counts as ranked (Pour toi is then asked as `foryou`). Every other
 * list has one shape. An empty page holds no other list's rows.
 */
export function rowsInListShape(
  feed: string,
  rows: readonly PostEntity[],
  rankedEstate: boolean
): boolean {
  if (feed !== 'foryou' || !rankedEstate) return true;
  return rows.every((r) => typeof r.feedAsOf === 'string');
}

/** Where the next page of a list starts, and in which shape it is asked. */
export interface ListPage {
  offset: number;
  /** A ranked list: the snapshot the page is a slice of. */
  asOf?: string;
  /** A ranked list's tail: the last tail row served. */
  cursor?: string;
  /**
   * THE SHAPE OF THE LIST, fixed by its first page: `true` when it was served ranked, `false` when
   * it was served in the older shape (a first launch that asked before the estate's capabilities
   * were read). Undefined for an empty list: the first page follows the estate. A list is never
   * paged in a shape other than the one its first page was served in, until a refresh.
   */
  rankedFeeds?: boolean;
}

/** The stable code of a ranked page whose snapshot is gone (`410`, `for-you-feed.ts`). */
export const RANKING_GONE = 'RANKING_GONE';

/** Whether a refusal says the snapshot a page named is gone - by its status AND code, never its text. */
export function isRankingGone(e: unknown): boolean {
  return e instanceof ApiRefusalError && e.status === 410 && e.code === RANKING_GONE;
}

function isRanked(row: PostEntity): boolean {
  return typeof row.feedAsOf === 'string' && typeof row.feedPosition === 'number';
}

/**
 * The page after the rows on screen. A ranked list continues its NEWEST snapshot (after a ranking
 * that was gone, the rows of the old one stay on screen and the new one is paged), after its last
 * place, below its last tail row. A list with rows and no ranking facts is paged by
 * `fallbackOffset` in the older shape it was served in.
 */
export function nextListPage(rows: readonly PostEntity[], fallbackOffset: number): ListPage {
  let last: PostEntity | undefined;
  for (const row of rows) {
    if (!isRanked(row)) continue;
    if (
      !last ||
      row.feedAsOf! > last.feedAsOf! ||
      (row.feedAsOf === last.feedAsOf && row.feedPosition! > last.feedPosition!)
    ) {
      last = row;
    }
  }
  if (!last) {
    return rows.length > 0
      ? { offset: fallbackOffset, rankedFeeds: false }
      : { offset: fallbackOffset };
  }
  return {
    offset: last.feedPosition! + 1,
    asOf: last.feedAsOf,
    ...(last.feedCursor ? { cursor: last.feedCursor } : {}),
    rankedFeeds: true,
  };
}

/**
 * A page appended to the rows on screen: the rows not shown yet go at the end; a row already shown
 * stays where it is, and takes the page's ranking facts (its place in the snapshot now paged), so
 * the next page starts after it. A chronological page keeps the rows as they are: a duplicate is
 * dropped, as the feed always did.
 */
export function mergeListPage(
  shown: readonly PostEntity[],
  page: readonly PostEntity[]
): { rows: PostEntity[]; appended: PostEntity[] } {
  const served = new Map(page.map((p) => [p.id, p]));
  const shownIds = new Set(shown.map((p) => p.id));
  const rows = shown.map((p) => {
    const again = served.get(p.id);
    if (!again || !isRanked(again)) return p;
    const { feedCursor: _old, ...rest } = p;
    return {
      ...rest,
      feedAsOf: again.feedAsOf,
      feedPosition: again.feedPosition,
      ...(again.feedCursor ? { feedCursor: again.feedCursor } : {}),
    };
  });
  const appended: PostEntity[] = [];
  for (const p of page) {
    if (shownIds.has(p.id)) continue;
    shownIds.add(p.id);
    appended.push(p);
  }
  return { rows: [...rows, ...appended], appended };
}

/**
 * READS THE NEXT PAGE OF A LIST and appends it, the ONE path of the feed's scroll and the CanaReels
 * viewer:
 *
 * - a ranked page whose snapshot is gone (`410 RANKING_GONE`: two hours without a page, or pushed
 *   out by newer rankings) is ranked anew - a first page of a new snapshot - and only the rows not
 *   on screen are appended; logged as a warning, since the reader scrolled a ranking that expired.
 *   ONCE per call: a second 410 is thrown, and the caller shows its retry;
 * - a ranked page that appended nothing new (every row was on screen: after a new ranking) reads
 *   the next one, until a row is new or the list ends - each read starts strictly after the last,
 *   so this ends;
 * - every other refusal (a `503`, the network) is thrown to the caller, which offers a retry.
 *
 * `ended` says the server has nothing after the last read.
 */
export async function readNextPage(input: {
  shown: readonly PostEntity[];
  limit: number;
  read: (page: ListPage & { limit: number }) => Promise<PostEntity[]>;
}): Promise<{ rows: PostEntity[]; appended: PostEntity[]; ended: boolean }> {
  const { limit, read } = input;
  let rows = [...input.shown];
  const appended: PostEntity[] = [];
  let page = nextListPage(rows, rows.length);
  let reranked = false;
  for (;;) {
    let raw: PostEntity[];
    try {
      raw = await read({ ...page, limit });
    } catch (e) {
      // AT MOST ONE re-rank per call: a second 410 means the new ranking is gone too, which no
      // further re-rank would mend - it goes to the caller, who offers the retry.
      if (!page.asOf || !isRankingGone(e) || reranked) throw e;
      reranked = true;
      Log.w(
        'RANKED',
        `the ranking of ${page.asOf} is gone at offset ${page.offset} - ranked anew, the rows on screen kept`
      );
      page = { offset: 0, rankedFeeds: true };
      raw = await read({ ...page, limit });
    }
    const merged = mergeListPage(rows, raw);
    rows = merged.rows;
    appended.push(...merged.appended);
    const ended = raw.length < limit;
    if (ended || appended.length >= limit || !raw.some(isRanked)) {
      return { rows, appended, ended };
    }
    const next = nextListPage(rows, rows.length);
    if (next.asOf === page.asOf && next.offset <= page.offset) {
      // The server served no place after the one asked: reading again would ask the same page.
      Log.w('RANKED', `a page at ${page.offset} moved the list no further - the list ends here`);
      return { rows, appended, ended: true };
    }
    Log.d(
      'RANKED',
      `page at ${page.offset} held only rows on screen - reading on at ${next.offset}`
    );
    page = next;
  }
}
