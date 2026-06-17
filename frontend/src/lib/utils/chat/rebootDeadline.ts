// ---------------------------------------------------------------------------
// Persistent wall-clock deadline before an MLS group reboot.
//
// A reboot (recreate the group as a successor) is the destructive last resort when a group
// stays unrecoverable. We must NOT trigger it on a short in-memory timer that resets on every
// reconnection/restart (that would require an hour of *continuous* uptime, or fire far too
// eagerly). Instead we record, per group, the wall-clock instant it was first observed
// not-ready-and-recoverable, persisted in localStorage so it survives reload and process kill.
// The reboot only fires once `now - notReadySince >= REBOOT_DEADLINE_MS` in real time - the
// counter never restarts on reconnection. Meanwhile welcome_request keeps being (re)emitted.
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
 * Milliseconds (wall-clock) since `groupId` was first marked not-ready, or null when no marker
 * exists. Used to decide whether the reboot deadline has elapsed.
 */
export function groupNotReadyForMs(userId: string, groupId: string): number | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(key(userId, groupId));
  if (raw === null) return null;
  const ts = parseInt(raw, 10);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Date.now() - ts);
}
