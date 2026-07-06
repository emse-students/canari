// ---------------------------------------------------------------------------
// Persistent registry of MLS groups that are not-ready-and-recoverable.
//
// Per group, we record the wall-clock instant it was first observed not-ready, persisted in
// localStorage so it survives reload and process kill. The SYNC_WATCHDOG (the sole recovery-cadence
// owner) enumerates this registry to drive re-adds for groups that have NO conversation record yet
// (a commit arrived before the Welcome), not only for live conversations.
// ---------------------------------------------------------------------------

const PREFIX = 'mls_not_ready_since';

function key(userId: string, groupId: string): string {
  return `${PREFIX}:${userId}:${groupId}`;
}

/**
 * Records that `groupId` is not-ready-and-recoverable, if not already recorded.
 * Idempotent: keeps the earliest instant so the wall-clock deadline is stable across sessions.
 */
export function markGroupNotReady(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  const k = key(userId, groupId);
  if (localStorage.getItem(k) === null) localStorage.setItem(k, String(Date.now()));
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
