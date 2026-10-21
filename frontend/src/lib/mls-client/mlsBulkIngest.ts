import type { IMlsService } from './IMlsService';
import type { MlsStatePersister } from './mlsStatePersister';
import { activeMlsStatePersister } from './mlsStatePersisterRegistry';

/**
 * Runs `fn` inside an MLS bulk-ingest window so disk persistence is deferred and a single
 * encrypted checkpoint is flushed when the window closes, then hands `fn`'s value to
 * `commitWhenDurable` once a checkpoint holding everything `fn` did has LANDED.
 *
 * ## Why the commit is not simply "after this call returns"
 *
 * This docblock used to say {@link IMlsService.endBulkIngest} resolves only after the flush, so a
 * caller could record durable progress markers (a history replay's stream cursor) after it. That
 * was false on every shipped build: the persister's `onBulkIngestEnd` STARTS the checkpoint and does
 * not await it - durability must not gate delivery - and a window closing inside another one (a live
 * drain) starts nothing at all. So the cursor was written ahead of the ratchet for the length of one
 * checkpoint, and a process killed there reloads a cursor past frames its state never applied: the
 * unsurvivable direction (`commitPendingHistoryMarks` says why only "state ahead of markers" is).
 *
 * ## What makes the ordering a proof
 *
 * The state is marked dirty AFTER `fn` resolved - so after the replay's session committed its
 * ratchet - and BEFORE the window closes; `flushEncrypted` then resolves only once a checkpoint that
 * started after that mark is on disk (its contract: a mark is cleared only by starting a checkpoint,
 * and a checkpoint that fails raises it again). At the outermost close that is the very checkpoint
 * the close starts, so the mark costs no extra write; inside a live drain it is one of its own.
 * A checkpoint that FAILS rejects `flushEncrypted`, and the commit then never runs: the markers stay
 * behind the state, which is the survivable direction.
 *
 * The commit is CHAINED, never awaited here: the caller's tail (drawing the replayed page) does not
 * wait for the disk, exactly as live delivery does not. Commits of successive windows run in
 * checkpoint order, because each waits on the persister's next checkpoint.
 *
 * The window is closed BY ITS HANDLE: a queue drain may open its own window while `fn` runs and
 * close it first, and a close that ended "the innermost" window ended the wrong one.
 *
 * Note: it intentionally does not enable UI bulk-buffering (that buffer is not depth-counted
 * and would clobber a concurrent queue-drain); only persistence deferral is engaged.
 *
 * @param commitWhenDurable writes the progress markers `fn` returned; runs at most once, and only
 *   after a checkpoint covering `fn` landed
 * @returns `fn`'s value, as soon as the window is closed
 * @see docs/wiki/protocols/mls-desync-prevention.md - "A history replay's markers wait for the
 *   checkpoint that holds it"
 */
export async function withMlsBulkIngest<T>(
  mlsService: Pick<IMlsService, 'beginBulkIngest' | 'endBulkIngest'>,
  fn: () => Promise<T>,
  commitWhenDurable: (value: T) => void
): Promise<T> {
  // The persister of THIS session, taken before the window opens: it is the observer this window's
  // close reaches, and a sign-out that replaces the registered one must not redirect the barrier.
  const persister = activeMlsStatePersister();
  const handle = mlsService.beginBulkIngest();
  let value: T;
  try {
    value = await fn();
    // Before the close, so the outermost close's own checkpoint is the one that covers `fn`.
    persister?.scheduleDeferred();
  } finally {
    await mlsService.endBulkIngest(handle);
  }
  void commitOnceCheckpointed(persister, () => commitWhenDurable(value));
  return value;
}

/** Runs `commit` once the persister's next checkpoint landed; never when it failed or is absent. */
async function commitOnceCheckpointed(
  persister: Pick<MlsStatePersister, 'flushEncrypted'> | null,
  commit: () => void
): Promise<void> {
  if (!persister) {
    // The pipeline registers its persister before any restore can replay (sessionAuth), so a replay
    // without one is a defect upstream, not a case: nothing checkpoints this window's state, and
    // committing would put the markers ahead of it.
    console.error(
      '[MLS] Bulk ingest closed with no state persister registered - progress markers withheld (the next replay re-walks from the previous cursor)'
    );
    return;
  }
  try {
    await persister.flushEncrypted();
  } catch (e) {
    console.warn(
      `[MLS] The checkpoint covering a bulk ingest failed - progress markers withheld, so they stay behind the state: ${String(e)}`
    );
    return;
  }
  console.debug('[MLS] Bulk ingest checkpoint landed - committing its progress markers.');
  try {
    commit();
  } catch (e) {
    // Nobody awaits this chain, so a throw would surface as an unhandled rejection and say nothing.
    console.error(`[MLS] Committing a bulk ingest's progress markers failed: ${String(e)}`);
  }
}
