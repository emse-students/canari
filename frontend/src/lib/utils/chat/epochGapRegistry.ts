/**
 * Process-global registry of groups stuck in an unresolved epoch gap (`msg_epoch > group_epoch`).
 *
 * A group enters the registry when the message pipeline receives a frame it cannot decrypt
 * because its local state lags behind in epoch; it leaves as soon as a commit actually
 * advances the epoch (gap resolved) or after a forget + re-Welcome escalation.
 *
 * Why a shared module rather than a Map local to the handler: the outbox (`isGroupHealthy`)
 * must be able to consult this state so it does NOT send an application message into a group
 * known to be lagging - otherwise the ciphertext is encrypted at a stale epoch and the
 * (up-to-date) recipients cannot decrypt it. The pipeline and the outbox live in separate
 * modules; a singleton avoids threading the Map through every layer.
 *
 * Only one session is active per process (the MLS WASM/Tauri state is itself global), so a
 * module-level Map carries no risk of collision between sessions.
 */

/** Timestamp (ms) of the first unresolved epoch gap, per group. */
const epochGapSince = new Map<string, number>();

/**
 * Marks a group as having entered an epoch gap if it was not already, and returns the
 * timestamp (ms) of the gap start (existing or newly recorded). Used to measure the gap
 * duration in order to decide on escalation.
 */
export function markEpochGap(groupId: string): number {
  const existing = epochGapSince.get(groupId);
  if (existing !== undefined) return existing;
  const now = Date.now();
  epochGapSince.set(groupId, now);
  return now;
}

/** Returns the gap start timestamp (ms) for this group, or `undefined` if it is not in a gap. */
export function getEpochGapSince(groupId: string): number | undefined {
  return epochGapSince.get(groupId);
}

/** Clears a group's gap state (gap resolved by a commit, or escalation triggered). */
export function clearEpochGap(groupId: string): void {
  epochGapSince.delete(groupId);
}

/**
 * True if ANY group is currently in an unresolved epoch gap.
 *
 * The SYNC_WATCHDOG's stuck-gap net is the only reason it needs a fine tick, and on a session with
 * nothing lagging that net has nothing to look at. Reading the registry's emptiness first is what
 * lets the tick return before crossing into WASM for `get_groups()` - a boundary it was paying for
 * every five seconds, for the whole session, to find nothing.
 */
export function anyEpochGapArmed(): boolean {
  return epochGapSince.size > 0;
}

/**
 * Every group whose gap has been open for longer than `olderThanMs`, oldest first.
 *
 * THE ESCALATOR MUST WALK THE REGISTRY, AND IT USED TO WALK A LIST BUILT FOR ANOTHER QUESTION. The
 * sync watchdog took its stuck-gap decision inside a loop over conversations plus the not-ready
 * registry - the set it needs for RE-ADDS - so a group in neither was marked here and never looked
 * at again. A Graine key-distribution group is exactly that: it is no conversation (the pipeline
 * branches on `isDistributionGroup` BEFORE both of the sites that clear a gap), and it is never
 * not-ready (it is joined by external commit, not by a Welcome). Its only way in is a refused
 * commit, and it had no way out at all short of a reload.
 *
 * So the set to iterate is this one. What to DO with each entry still depends on the group, and
 * that decision stays with the caller: the two kinds do not share a ladder.
 */
export function stuckEpochGaps(olderThanMs: number, now: number = Date.now()): string[] {
  const stuck: Array<[string, number]> = [];
  for (const [groupId, since] of epochGapSince) {
    if (now - since > olderThanMs) stuck.push([groupId, since]);
  }
  return stuck.sort((a, b) => a[1] - b[1]).map(([groupId]) => groupId);
}

/** True if the group is currently in an unresolved epoch gap (therefore not sendable). */
export function isInEpochGap(groupId: string): boolean {
  return epochGapSince.has(groupId);
}

/**
 * Empties the whole registry. Called when a session initializes (message handler setup) to
 * start from a clean state: an unresolved gap from a previous session (logout without
 * resolution) must not survive a re-login and freeze the outbox indefinitely - application
 * messages do not resolve a gap (only a commit does), so a stale entry would never clear
 * itself without a new undecryptable frame triggering the escalation.
 */
export function resetEpochGapRegistry(): void {
  epochGapSince.clear();
}
