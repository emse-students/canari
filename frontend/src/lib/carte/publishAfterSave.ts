/**
 * "Publish" as the editor means it: save FIRST, then put online exactly what was saved.
 *
 * Two defects shaped it. A publish that follows a failed save puts online a map no reopen could
 * reproduce, and a publish that reads the editor AFTER the save's await puts online an edit made
 * while the save was in flight - a state the server was never given.
 *
 * So the document is snapshotted BEFORE the save and published from that snapshot, and it is only
 * published when the save wrote that very state (`savedKey` is the key the save pinned at its
 * start). An edit made during the await changes neither; one made before the save began (a save
 * queued behind another) makes the keys differ and the loop saves again from a fresh snapshot.
 */

/** What one snapshot holds: the document parameters and the key identifying the saved state. */
export interface PublishSnapshot<S> {
  /** The layout fingerprint of the state `params` were read from. */
  key: string;
  params: S;
}

/** The editor's side of the publish. */
export interface PublishDeps<S> {
  /** Reads the document parameters now, with the key of the state they describe. */
  snapshot: () => PublishSnapshot<S>;
  /** Saves the layout; false means it did not reach the server (the error is already shown). */
  save: () => Promise<boolean>;
  /** The key of the state the last successful save wrote; null while unknown. */
  savedKey: () => string | null;
  /** Puts the snapshot online; rejects when the server refuses. */
  publish: (params: S) => Promise<void>;
}

/** How a run ended. `busy`: another publish was already running, nothing was done. */
export type PublishOutcome = 'published' | 'save-failed' | 'busy';

/** Re-saves allowed when the state moved between the snapshot and the save; no clock, a bound. */
const MAX_RESAVES = 5;

/**
 * Builds the publish action. It runs one publish at a time: a second call while one is running is
 * `busy` and does nothing, so a double click publishes once.
 *
 * A rejection of `publish` propagates (the caller maps it to a message) and frees the guard.
 */
export function publishAfterSave<S>(deps: PublishDeps<S>): () => Promise<PublishOutcome> {
  let running = false;
  return async () => {
    if (running) return 'busy';
    running = true;
    try {
      for (let attempt = 0; attempt <= MAX_RESAVES; attempt++) {
        const snap = deps.snapshot();
        if (!(await deps.save())) return 'save-failed';
        if (deps.savedKey() !== snap.key) continue;
        await deps.publish(snap.params);
        return 'published';
      }
      return 'save-failed';
    } finally {
      running = false;
    }
  };
}
