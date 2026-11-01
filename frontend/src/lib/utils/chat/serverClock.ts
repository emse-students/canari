/**
 * The newest instant THE SERVER ITSELF has stated to this account on this device: a delivered
 * frame's `queued_message.createdAt` (live, relayed by the leader tab, or carried by a push into the
 * native cache), the `receivedAt` an own send answered (foreground or background).
 *
 * WHY IT EXISTS. Since 2026-10-31 a DM or group read mark is on the server's clock
 * (`readMarkTarget`), taken from the rows held - and a row's `serverTimestamp` may have come from a
 * HISTORY BUNDLE, written by the member who relayed it. Bundle times are vetted on ingest
 * (`vettedBundleServerTime`), but a row stored by an older build was not, and the merge of a mark is
 * `max`, so one row dated 2100 would mark every later message read, for good. Clamping the target to
 * what the server has said bounds it by a fact no member controls.
 *
 * DURABLE AND PER ACCOUNT (review of #2824, B): a value held in memory only was 0 in a follower tab
 * that never received a frame itself and on a boot with no network, and 0 meant "unbounded". It is
 * kept under `ACCOUNT_KEY.serverClock`, only ever moves forward, and is never shared between
 * accounts. While NOTHING is known the server mark does not move at all (`serverMarkCeiling`).
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * What this tab noted per account (lower-cased) - the floor when storage cannot be written. Storage
 * is READ AGAIN on every ask: it is shared by the tabs of one origin, so a follower tab that never
 * receives a frame itself is bounded by what the leader noted a moment ago.
 */
const held = new Map<string, number>();

/** Whether this runtime has the shared store at all (a worker, or Node in a unit test, has none). */
const hasStorage = (): boolean => typeof localStorage !== 'undefined';

function load(userNorm: string): number {
  const mine = held.get(userNorm) ?? 0;
  if (!hasStorage()) return mine;
  try {
    const stored = Number(localStorage.getItem(ACCOUNT_KEY.serverClock(userNorm)));
    return Number.isFinite(stored) && stored > mine ? stored : mine;
  } catch (e) {
    console.warn(`[READ] server clock of ${userNorm.slice(0, 8)} not readable: ${String(e)}`);
    return mine;
  }
}

/**
 * Notes a time the server stated directly (ms) for `userId`. Ignores anything that is not a positive
 * number, and anything not newer than what is held.
 */
export function noteServerTime(userId: string, at: number | undefined): void {
  if (!userId || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return;
  const userNorm = userId.trim().toLowerCase();
  if (at <= load(userNorm)) return;
  held.set(userNorm, at);
  if (!hasStorage()) return;
  try {
    localStorage.setItem(ACCOUNT_KEY.serverClock(userNorm), String(at));
  } catch (e) {
    // Kept in memory for this session: the bound still holds until the next boot.
    console.warn(`[READ] server clock of ${userNorm.slice(0, 8)} not persisted: ${String(e)}`);
  }
}

/** The newest server-stated instant for `userId` on this device, 0 when the server has stated none. */
export function serverTimeSeen(userId: string): number {
  if (!userId) return 0;
  return load(userId.trim().toLowerCase());
}

/** Test seam: forget what memory holds, so the next read goes back to storage. */
export function resetServerClockForTests(): void {
  held.clear();
}
