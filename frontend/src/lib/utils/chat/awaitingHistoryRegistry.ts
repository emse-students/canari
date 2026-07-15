// ---------------------------------------------------------------------------
// Persistent registry of MLS groups still awaiting their pre-join history bundle.
//
// A device that (re)joins a group via an external commit or a Welcome lands at the current epoch
// WITHOUT the pre-join history it cannot decrypt on its own: it must solicit a re-encrypted bundle
// from an online member. That solicitation used to be a one-shot burst tied to the join event
// (bounded retries over ~3 min, in-memory only). If the sole reachable member stayed offline for
// that window, the bundle never arrived AND was never re-requested - a later session finds the group
// already in WASM, so recovery (which owns the solicit) short-circuits and never re-solicits.
//
// This registry makes the "still needs history" intent durable: it is set when a solicitation
// starts and cleared once a bundle actually arrives. The connection sync re-solicits every awaiting
// group on each (re)connect, so the history is retried across sessions until it lands.
// ---------------------------------------------------------------------------

const PREFIX = 'mls_awaiting_history_since';

/**
 * Give-up horizon: past this age we stop re-soliciting and drop the marker. Pre-join history is not
 * urgent, and a group whose only other member is permanently gone must not solicit (and grow
 * localStorage) forever. Generous because a peer can legitimately be away for weeks.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function key(userId: string, groupId: string): string {
  return `${PREFIX}:${userId}:${groupId}`;
}

/**
 * Records that `groupId` is awaiting its history bundle, if not already recorded. Idempotent: keeps
 * the earliest instant so the give-up horizon is stable across sessions.
 */
export function markAwaitingHistory(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  const k = key(userId, groupId);
  if (localStorage.getItem(k) === null) localStorage.setItem(k, String(Date.now()));
}

/** Clears the awaiting-history marker for `groupId` (bundle arrived, or the group was dropped). */
export function clearAwaitingHistory(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(key(userId, groupId));
}

/**
 * All groupIds for `userId` still awaiting their history bundle. Entries older than
 * {@link MAX_AGE_MS} are considered given-up and are pruned as a side effect of enumeration, so the
 * registry stays bounded without a separate GC pass.
 */
export function enumerateAwaitingHistory(userId: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const prefix = `${PREFIX}:${userId}:`;
  const now = Date.now();
  const out: string[] = [];
  const expired: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === null || !k.startsWith(prefix)) continue;
    const since = Number(localStorage.getItem(k));
    if (Number.isFinite(since) && now - since > MAX_AGE_MS) {
      expired.push(k);
      continue;
    }
    out.push(k.slice(prefix.length));
  }
  for (const k of expired) localStorage.removeItem(k);
  return out;
}
