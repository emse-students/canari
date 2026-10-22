/**
 * WHETHER THE ANSWER TO OUR HISTORY ASK ARRIVED WHOLE, durably (channel-encryption section 4.4).
 *
 * A history answer larger than one page travels as several bundles (`bundlePages.ts`). Each seed is
 * stored on its own, so a missing page corrupts nothing - but the history ask itself is made only
 * while this device holds NO seed of the community (`requestCommunityHistory`), and the first page
 * that lands ends that condition. A page lost after it (the answerer's send failing halfway) would
 * then never be asked for as a whole: only session by session, as rows under it fail to open - which
 * hides those rows until each repair lands (section 4.5).
 *
 * **What a record answers, and only that:** "the history ask of this community is request R, and of
 * its answer in N pages these arrived". It is written when the ask is SENT (so a page arriving after a
 * restart is still recognised) and updated as each page is ABSORBED (after its seeds are stored). A
 * complete answer - every page, or an answer of one message - deletes it. At the next start, an
 * incomplete one asks ONCE more ({@link incompleteHistoryPages}); `reasked` is what bounds that to
 * once, and it survives the re-ask's own record so a second incomplete answer is left to the
 * per-session repair. No clock is involved: the trigger is the next start, and the evidence is which
 * page numbers arrived.
 *
 * In `localStorage` per account, like `historyAnswered.ts`: a few bytes, survives a restart. A
 * storage that refuses is logged and read as no record - the reading that asks nothing more than
 * before this existed.
 */

import { ACCOUNT_KEY } from '../accountLocalKeys';

/** One community's history ask and what arrived of its answer. */
interface PagedHistoryRecord {
  requestId: string;
  /** 0 until a paged answer's first page arrives. */
  pageCount: number;
  /** The page indexes absorbed, sorted. */
  received: number[];
  /** This community was already re-asked once for an incomplete answer. */
  reasked: boolean;
}

type Records = Record<string, PagedHistoryRecord>;

function isRecord(value: unknown): value is PagedHistoryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<PagedHistoryRecord>;
  return (
    typeof r.requestId === 'string' &&
    typeof r.pageCount === 'number' &&
    Array.isArray(r.received) &&
    r.received.every((n) => typeof n === 'number') &&
    typeof r.reasked === 'boolean'
  );
}

function readAll(userId: string): Records {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer(userId));
  } catch (error) {
    console.warn(`[GRAINE] the paged history answers could not be read: ${String(error)}`);
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[GRAINE] the paged history answers are not valid JSON - read as none: ${String(error)}`
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[GRAINE] the paged history answers are not an object - read as none');
    return {};
  }
  const records: Records = {};
  for (const [workspaceId, value] of Object.entries(parsed)) {
    if (isRecord(value)) records[workspaceId] = value;
    else
      console.warn(
        `[GRAINE] the paged history answer of community ${workspaceId.slice(0, 8)} is malformed - read as none`
      );
  }
  return records;
}

function writeAll(userId: string, records: Records): void {
  try {
    if (Object.keys(records).length === 0)
      localStorage.removeItem(ACCOUNT_KEY.pagedHistoryAnswer(userId));
    else localStorage.setItem(ACCOUNT_KEY.pagedHistoryAnswer(userId), JSON.stringify(records));
  } catch (error) {
    // Lost, and said: the cost is a missing page recovered session by session, as before.
    console.warn(`[GRAINE] the paged history answers could not be written: ${String(error)}`);
  }
}

/**
 * Records that the history ask of `workspaceId` is now `requestId`. Called before the request is
 * sent, for the reason `historyRequest` is set before it: the answer may be handled first.
 *
 * @param reask This ask is the one re-ask an incomplete answer earns - so it is never earned again.
 * @returns Puts back the record this replaced: for a send that failed, which nothing can answer and
 *   which must not spend the re-ask.
 */
export function noteHistoryAsked(
  userId: string,
  workspaceId: string,
  requestId: string,
  reask: boolean
): () => void {
  const records = readAll(userId);
  const previous = records[workspaceId];
  const reasked = reask || (previous?.reasked ?? false);
  records[workspaceId] = { requestId, pageCount: 0, received: [], reasked };
  writeAll(userId, records);
  return () => {
    const now = readAll(userId);
    if (now[workspaceId]?.requestId !== requestId) return;
    if (previous) now[workspaceId] = previous;
    else delete now[workspaceId];
    writeAll(userId, now);
  };
}

/**
 * Records that a bundle answering `requestId` was absorbed. Anything but our history ask is ignored.
 * An answer of one message (`pageCount` 0) and the last missing page both close the record.
 */
export function noteHistoryPage(
  userId: string,
  workspaceId: string,
  requestId: string,
  pageIndex: number,
  pageCount: number
): void {
  const records = readAll(userId);
  const record = records[workspaceId];
  if (!record || record.requestId !== requestId) return;
  if (pageCount === 0) {
    delete records[workspaceId];
    writeAll(userId, records);
    return;
  }
  const received = new Set(record.received);
  received.add(pageIndex);
  const whole = Array.from({ length: pageCount }, (_, i) => i).every((i) => received.has(i));
  if (whole) {
    console.debug(
      `[GRAINE] the history answer of community ${workspaceId.slice(0, 8)} arrived whole: ${pageCount} page(s) of request ${requestId}`
    );
    delete records[workspaceId];
  } else {
    records[workspaceId] = { ...record, pageCount, received: [...received].sort((a, b) => a - b) };
  }
  writeAll(userId, records);
}

/**
 * The page indexes still missing from the history answer of `workspaceId`, when that answer arrived
 * in part and has not been re-asked yet - else `null`. Read-only: the re-ask is spent only when it is
 * SENT ({@link noteHistoryAsked} with `reask`), so an ask that finds nobody online keeps it.
 */
export function incompleteHistoryPages(userId: string, workspaceId: string): number[] | null {
  const record = readAll(userId)[workspaceId];
  if (!record || record.pageCount === 0 || record.reasked) return null;
  const received = new Set(record.received);
  const missing = Array.from({ length: record.pageCount }, (_, i) => i).filter(
    (i) => !received.has(i)
  );
  return missing.length > 0 ? missing : null;
}

/** Forgets the record of `workspaceId`: the community left this device, and its asks went with it. */
export function forgetPagedHistoryAnswer(userId: string, workspaceId: string): void {
  const records = readAll(userId);
  if (!(workspaceId in records)) return;
  delete records[workspaceId];
  writeAll(userId, records);
}
