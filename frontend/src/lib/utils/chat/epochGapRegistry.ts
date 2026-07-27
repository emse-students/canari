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
