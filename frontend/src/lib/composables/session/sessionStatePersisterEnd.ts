import {
  unregisterMlsStatePersister,
  activeMlsStatePersister,
  flushActiveMlsStateEncrypted,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import { uninstallMlsStatePersisterLifecycle } from '$lib/mls-client/mlsStatePersisterLifecycle';
import { disposeMlsEncryptWorker } from '$lib/mls-client/mlsEncryptWorkerSession';
import { holdLeadWhile } from '$lib/mls-client/leadHolds';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';

/**
 * The final write of the LAST session ended in this document - see {@link whenEndedSessionStateWritten}.
 * Not a chain of every one: a put that never settled would then stall every later sign-out.
 */
let lastFinalWrite: Promise<void> = Promise.resolve();

/**
 * Ends the MLS state persister of the session that is ending: with its final checkpoint when the
 * state in memory is still the account's (a sign-out, an expired session), without one when writing
 * it would be wrong (a revoked device, whose state is about to be wiped; a lost session, whose client
 * no longer describes what is installed).
 *
 * **CALL IT BEFORE THE SESSION FLAG FALLS.** The final checkpoint is counted as an operation that
 * needs the lead (`holdLeadWhile`), from this call, so the session that ends gives the lead up only
 * once the write has landed - given up first, the write latch would refuse it from a follower.
 *
 * **ONLY WHAT THIS SESSION INSTALLED IS REMOVED**, once the write settled: a newer session may have
 * registered its own by then (`unregisterMlsStatePersister(owner)`). Removing it stops this
 * session's persister from SCHEDULING more checkpoints of the ended client (review of #4053, the
 * expired-session path, which used to leave it installed). What fences a late write that is already
 * under way is not the registry but the write latch (`refusesCommitsHere`, read at the put) and the
 * state's version guard, which refuse it in a document that no longer leads or that a newer write
 * has overtaken.
 *
 * NEVER REJECTS: the caller chains the MLS client's retirement, and the next login's wait, on it.
 */
export function endSessionStatePersister(
  finalCheckpoint: boolean,
  log: (message: string) => void
): Promise<void> {
  const persister = activeMlsStatePersister();
  const release = () => {
    uninstallMlsStatePersisterLifecycle(persister);
    unregisterMlsStatePersister(persister);
    // The encrypt worker is shared and recreated on demand; it is disposed only when no session has
    // registered a persister since - the one that has may be using it.
    if (activeMlsStatePersister() === null) disposeMlsEncryptWorker();
  };
  if (!finalCheckpoint || persister === null) {
    log(
      `[SESSION] state persister ended without a final checkpoint (${persister ? 'not owed' : 'none installed'})`
    );
    release();
    return Promise.resolve();
  }
  log(
    '[SESSION] state persister ends after its final checkpoint - the lead is held until it lands'
  );
  // Dispose after the final flush: flushEncrypted relies on the encrypt worker.
  const written = holdLeadWhile('final checkpoint of an ended session', () =>
    flushActiveMlsStateEncrypted().catch((e) => {
      // A REFUSAL HAS BEEN SAID WHERE IT WAS DECIDED (the version guard, or a follower tab, which
      // owns no MLS state to write); only an unexplained failure is said here.
      if (e instanceof MlsStateWriteRefusedError) return;
      console.error(`[SESSION] Final MLS checkpoint failed: ${String(e)}`);
    })
  ).then(release);
  lastFinalWrite = written;
  return written;
}

/**
 * Settles once the final checkpoint of the LAST session ended here has landed (or failed). A
 * sign-out that finds no live session - the expired session it ends was already let go of - retires
 * the client behind this, so it is never destroyed under its own final write. That client is the
 * last session's: an older session's write, even one that never settles, is not waited for.
 */
export function whenEndedSessionStateWritten(): Promise<void> {
  return lastFinalWrite;
}
