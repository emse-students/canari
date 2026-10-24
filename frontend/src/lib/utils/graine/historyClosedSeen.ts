/**
 * THE COMMUNITIES WHOSE PAST THIS DEVICE WAS LAST TOLD IS CLOSED (`historyVisibility = 'joined'`),
 * durably - what makes a later `shared` a widening this device owes a history ask.
 *
 * WHY IT IS NEEDED. A member who joined under `joined` holds floored seeds (raised `firstIndex`) and
 * none of the sessions minted wholly before their arrival. When an admin switches the community to
 * `shared`, nothing used to ask for that past again: `requestCommunityHistory` returns once ANY seed
 * is held, and a row below a raised floor is classed "sent before this device was given the seed",
 * which asks nobody (asking would loop on the same floor). So the widening reached the setting and
 * never the members already in.
 *
 * WHY DURABLE. Most members are offline when an admin flips the setting; they learn `shared` from
 * the next listing, with nothing in memory saying it used to be `joined`. The record answers exactly
 * one question - "was the past closed when this device last heard, and has the widened ask been
 * answered?" - and it moves only on EVENTS, never on a clock:
 *
 * - `closed`: the server said `joined` ({@link noteHistoryClosed});
 * - `widened`: the server then said `shared`, and the "I hold nothing" answers given under the
 *   floor were forgotten ONCE ({@link beginHistoryWidening}) - once, because the walk down the
 *   roster re-enters the ask after each answer, and forgetting at each entry would re-ask the same
 *   member for ever;
 * - gone: a member ANSWERED the widened ask with seeds, the ask went final, or there was nobody to
 *   ask at all, or the community left this device ({@link settleHistoryWidening}). A start that could
 *   not ask (nobody online, a key group behind) keeps the record, and the next start asks.
 *
 * WHAT IT IS NOT. Never a reading of the rule itself: the seed layer reads the rule from the server's
 * answer of this session (`historyVisibilityFor`), and this record never decides what a seed may be
 * handed to. A record written for a rule nobody stated would be a widening that never happened, so
 * it is written only from a rule the server did state (`knownHistoryVisibility`).
 *
 * In `localStorage` per account, like `historyAnswered.ts`: community ids and one word each, read
 * synchronously. A storage that refuses is logged and reads as no record - which costs a widening
 * its re-ask (the rows still ask their sessions one by one), never a past handed out.
 */

import { ACCOUNT_KEY } from '../accountLocalKeys';
import { forgetWorkspaceRecord } from './workspaceRecords';

/** Where one community stands - see the module comment. */
type ClosedHistoryState = 'closed' | 'widened';

type Records = Record<string, ClosedHistoryState>;

/** Every well-formed record of `userId`. Anything malformed reads as none, out loud. */
function readAll(userId: string): Records {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.historyClosedSeen(userId));
  } catch (error) {
    console.warn(`[GRAINE] the closed-history record could not be read: ${String(error)}`);
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[GRAINE] the closed-history record is not valid JSON - read as none: ${String(error)}`
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[GRAINE] the closed-history record is not an object - read as none');
    return {};
  }
  const records: Records = {};
  for (const [workspaceId, state] of Object.entries(parsed)) {
    if (state === 'closed' || state === 'widened') records[workspaceId] = state;
    else
      console.warn(
        `[GRAINE] the closed-history record of community ${workspaceId.slice(0, 8)} is malformed - read as none`
      );
  }
  return records;
}

function writeAll(userId: string, records: Records): void {
  try {
    if (Object.keys(records).length === 0)
      localStorage.removeItem(ACCOUNT_KEY.historyClosedSeen(userId));
    else localStorage.setItem(ACCOUNT_KEY.historyClosedSeen(userId), JSON.stringify(records));
  } catch (error) {
    // Lost, and said: the cost is a widening that does not re-ask, never a past handed out.
    console.warn(`[GRAINE] the closed-history record could not be written: ${String(error)}`);
  }
}

/**
 * Records that the server told this device the past of `workspaceId` is closed (`joined`). A
 * widening still unanswered goes back to `closed`: the past is closed again, and nothing is owed.
 */
export function noteHistoryClosed(userId: string, workspaceId: string): void {
  const records = readAll(userId);
  if (records[workspaceId] === 'closed') return;
  records[workspaceId] = 'closed';
  writeAll(userId, records);
}

/**
 * The server says `shared` now: whether this device owes the community a widened history ask.
 *
 * @returns `first` the first time a closed past is seen widened - the caller forgets the answers
 *   given under the floor, once; `continuing` while that ask is still unanswered; `none` when the
 *   past was never closed to this device, or the widening has been settled.
 */
export function beginHistoryWidening(
  userId: string,
  workspaceId: string
): 'first' | 'continuing' | 'none' {
  const records = readAll(userId);
  const state = records[workspaceId];
  if (state === undefined) return 'none';
  if (state === 'widened') return 'continuing';
  records[workspaceId] = 'widened';
  writeAll(userId, records);
  return 'first';
}

/**
 * The widened history ask of `workspaceId` was answered, went final, or had nobody to ask: the
 * record has answered its question and is dropped. A `closed` record is KEPT - an answer to an ask
 * made while the past is closed settles nothing about a later widening.
 *
 * @returns whether a widening was settled.
 */
export function settleHistoryWidening(userId: string, workspaceId: string): boolean {
  const records = readAll(userId);
  if (records[workspaceId] !== 'widened') return false;
  delete records[workspaceId];
  writeAll(userId, records);
  return true;
}

/** The community left this device: whatever was recorded about its past goes with it. */
export function forgetHistoryClosedSeen(userId: string, workspaceId: string): void {
  forgetWorkspaceRecord(userId, workspaceId, readAll, writeAll);
}
