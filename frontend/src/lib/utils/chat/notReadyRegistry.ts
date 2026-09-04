// ---------------------------------------------------------------------------
// Persistent registry of MLS groups that are not-ready-and-recoverable.
//
// Per group, we record the wall-clock instant it was first observed not-ready, persisted in
// localStorage so it survives reload and process kill. The SYNC_WATCHDOG (the sole recovery-cadence
// owner) enumerates this registry to drive re-adds for groups that have NO conversation record yet
// (a commit arrived before the Welcome), not only for live conversations.
//
// PRESENCE SELECTS, THE INSTANT ONLY REPORTS. Nothing here is a deadline and nothing terminates on
// the clock - see `markGroupNotReady`.
// ---------------------------------------------------------------------------

const PREFIX = 'mls_not_ready_since';

function key(userId: string, groupId: string): string {
  return `${PREFIX}:${userId}:${groupId}`;
}

/**
 * Records that `groupId` is not-ready-and-recoverable, if not already recorded.
 *
 * Idempotent, and it keeps the EARLIEST instant: the value answers "since when", so a later mark
 * must not move it. NOTHING TERMINATES ON IT - there is no deadline here and there must not be one
 * (termination comes from a proof: a join, a confirmed-absent group, a 403 from the roster). The
 * instant is EVIDENCE, read by {@link readNotReadySince} so the recovery log can say how long a
 * group has been waiting; a marker that is hours old and one that is five days old are the same
 * line otherwise, and only the second names a defect.
 */
export function markGroupNotReady(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  const k = key(userId, groupId);
  if (localStorage.getItem(k) === null) localStorage.setItem(k, String(Date.now()));
}

/**
 * The instant `groupId` was FIRST seen not-ready, or `undefined` when it carries no marker.
 *
 * Read for the log line only. It used to be written and never read at all, which made the stored
 * timestamp indistinguishable from a `'1'` while the module's own doc described a wall-clock
 * deadline that did not exist.
 */
export function readNotReadySince(userId: string, groupId: string): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(key(userId, groupId));
  if (raw === null) return undefined;
  const at = Number(raw);
  // A marker written by an older build, or corrupted: its presence still means not-ready, so the
  // caller must not lose that - only the age is unavailable.
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** Clears the not-ready marker for `groupId` (group became healthy / was deleted). */
export function clearGroupNotReady(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(key(userId, groupId));
}

/**
 * All groupIds currently marked not-ready for `userId`. This registry is the single source of
 * truth for "groups needing recovery": the SYNC_WATCHDOG (the sole recovery-cadence owner)
 * enumerates it to drive re-adds for groups that have NO conversation record yet - a commit
 * arrived before the Welcome - not only for live conversations.
 *
 * It reads the KEYS: presence is what selects a group, never the stored instant.
 */
export function enumerateNotReadyGroups(userId: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const prefix = `${PREFIX}:${userId}:`;
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}
