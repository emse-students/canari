import type { IMlsService } from './IMlsService';
import { recordMlsSaveStateMs } from './catchupBenchmark';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Configuration for coalesced MLS state persistence. */
export interface MlsStatePersisterConfig {
  mlsService: IMlsService;
  log?: (msg: string) => void;
}

/**
 * Coalesced MLS state writer.
 * Routine ratchet advances stay in WASM memory; only encrypted checkpoints hit disk.
 */
export interface MlsStatePersister {
  /** Marks state dirty and flushes encrypted soon (same-tick calls are merged). */
  persistNow(): void;
  /** Marks state dirty in RAM (no disk write until an encrypted checkpoint). */
  scheduleDeferred(): void;
  /** Flushes encrypted checkpoint immediately if dirty. */
  flush(): Promise<void>;
  /** Alias for {@link flush} — encrypted checkpoint for backgrounding / logout. */
  flushEncrypted(): Promise<void>;
  /** Called when bulk message ingest starts - defers disk writes until ingest ends. */
  onBulkIngestStart(): void;
  /** Called when bulk ingest ends - encrypted flush if state changed during ingest. */
  onBulkIngestEnd(): Promise<void>;
}

/**
 * Creates a coalesced MLS persistence helper used by the inbound message pipeline.
 * Application-message ratchet updates are kept in WASM memory; commits and explicit
 * flush() write a checkpoint to IndexedDB, sealed with the device key.
 */
export function createMlsStatePersister(config: MlsStatePersisterConfig): MlsStatePersister {
  const { mlsService, log } = config;

  let dirtyEncrypted = false;
  let immediateFlushQueued = false;
  /** The checkpoint being written now, or null. */
  let inFlightEncrypted: Promise<void> | null = null;
  /**
   * The checkpoint that will start once {@link inFlightEncrypted} ends, shared by every caller that
   * asked for durability while it was running - or null.
   */
  let queuedEncrypted: Promise<void> | null = null;
  let bulkIngestDepth = 0;

  async function runSaveEncrypted(): Promise<void> {
    await yieldToMainThread();
    const saveStarted = typeof performance !== 'undefined' ? performance.now() : null;
    // ONE CALL, BECAUSE THE PLATFORM OWNS WHAT DURABLE MEANS. This used to be `saveState` followed
    // by `saveMlsStateEncrypted`, which is right on web and writes `mls.bin` TWICE on native - the
    // second time marshalling the whole snapshot through IPC as a `number[]`. Split-timing the two
    // halves on the phone is what showed it: 3.7 s per checkpoint, 1.7 s of real save and 2.0 s of
    // duplicate. The fact was already in the codebase, on `persistCheckpoint`; this call site had
    // its own copy of the answer and the copy was wrong.
    await mlsService.persistCheckpoint();
    const saveMs = saveStarted === null ? null : performance.now() - saveStarted;
    if (saveMs !== null) recordMlsSaveStateMs(saveMs);
    log?.(
      `[MLS] Encrypted state checkpoint persisted.${saveMs === null ? '' : ` (${Math.round(saveMs)} ms)`}`
    );
  }

  /** Starts a checkpoint of everything marked dirty so far. Only called with none in flight. */
  function startFlight(): Promise<void> {
    if (!dirtyEncrypted) return Promise.resolve();
    dirtyEncrypted = false;
    inFlightEncrypted = runSaveEncrypted()
      .catch((e) => {
        // A FAILED WRITE LEAVES THE STATE AHEAD OF THE DISK, so it is dirty again: the next trigger
        // must write it. Clearing the flag at the start and never raising it again left a state that
        // no later `flush` would ever write until something else marked it.
        dirtyEncrypted = true;
        log?.(`[MLS] Encrypted state checkpoint failed: ${String(e)}`);
        throw e;
      })
      .finally(() => {
        inFlightEncrypted = null;
      });
    return inFlightEncrypted;
  }

  /**
   * Resolves once every change marked dirty BEFORE this call is on disk.
   *
   * A CALLER THAT ASKS FOR DURABILITY WHILE A CHECKPOINT IS RUNNING WAITS FOR THE NEXT ONE. That
   * checkpoint exported the state before the caller's change, so it cannot make the change durable.
   * This function used to return the running checkpoint's promise in that case, and start the next
   * one unawaited. `externalJoin` awaits {@link persistMlsStructuralCheckpoint} because a reload
   * before its join is on disk joins again and forks the group, and after a sign-in a checkpoint is
   * running ~93 % of the time (Mi 9T, 2026-10-13: 247 checkpoints in 432 s). So nearly every join of
   * that storm was declared durable when it was not.
   *
   * Coalescing is unchanged: every caller arriving during one checkpoint shares ONE next checkpoint.
   */
  function flushEncryptedInternal(): Promise<void> {
    // A next checkpoint is already promised; it starts after the running one and covers every
    // change made until then, this caller's included.
    if (queuedEncrypted) return queuedEncrypted;
    if (inFlightEncrypted) {
      // Nothing changed since the running checkpoint exported: it is the one that covers us.
      if (!dirtyEncrypted) return inFlightEncrypted;
      queuedEncrypted = inFlightEncrypted
        .catch(() => {
          // Already logged by `startFlight`; its failure re-raised the dirty flag, so the next
          // checkpoint below writes that state too.
        })
        .then(() => {
          queuedEncrypted = null;
          return startFlight();
        });
      return queuedEncrypted;
    }
    return startFlight();
  }

  function scheduleDeferred(): void {
    dirtyEncrypted = true;
  }

  function persistNow(): void {
    dirtyEncrypted = true;
    if (bulkIngestDepth > 0) return;
    if (immediateFlushQueued) return;
    immediateFlushQueued = true;
    queueMicrotask(() => {
      immediateFlushQueued = false;
      // Already logged by `startFlight`; nobody awaits this one, so its rejection stops here.
      void flushEncryptedInternal().catch(() => {});
    });
  }

  return {
    persistNow,
    scheduleDeferred,
    flush: flushEncryptedInternal,
    flushEncrypted: flushEncryptedInternal,
    onBulkIngestStart() {
      bulkIngestDepth += 1;
      log?.(`[MLS] Disk writes deferred (bulk ingest depth=${bulkIngestDepth})`);
    },
    /**
     * DURABILITY MUST NOT GATE DELIVERY, which is why the flush is started here and NOT awaited.
     *
     * `BaseMlsService.endBulkIngest` awaits every observer, so awaiting the checkpoint kept the
     * ingest window open for as long as the disk took - and the next frame, already received, waited
     * for the whole Argon2 round trip before it was even decrypted. Measured on a cold web client on
     * 2026-08-14: 8.0 s between `Bulk ingest done` and `checkpoint persisted`, with the next
     * `Drain start` on the far side of it and a 50 ms API round trip inside the gap proving nothing
     * else was blocked. The same check was 279-327 ms on its four other passes: bimodal, because the
     * first checkpoint of a session pays what the later ones do not.
     *
     * The file already states the principle two functions up, for the failure case: a failed disk
     * write must cost a checkpoint, never the message pipeline. A SLOW disk write is the same claim.
     *
     * Nothing is lost by not waiting. Ordering across a slow flush is already guaranteed elsewhere -
     * every snapshot is tagged with a monotonic version and `saveMlsStateEncrypted` refuses a blob
     * that is not strictly newer - and this checkpoint carries INBOUND state, which a reload can
     * recover by replaying from the server. The outbound half, which cannot be recovered that way,
     * is checkpointed on the send path instead (`BaseMlsService.sendMessage`).
     *
     * A WINDOW THAT CHANGED NOTHING DURABLE WRITES NOTHING (2026-10-14). This used to raise the dirty
     * flag unconditionally, as a catch-all for any mutation no handler had marked - so a window that
     * decrypted nothing (an empty history probe, frames for a conversation not restored yet) still
     * sealed and rewrote the whole state. The catch-all is now a PROOF: when no handler marked the
     * window, the manager and the two ledgers are asked whether a checkpoint would make anything
     * durable ({@link MlsStatePersisterConfig.mlsService} `checkpointOwed`), and only `owed: false`
     * skips it. A decrypted frame of ANY kind - a read watermark included - moves the receive ratchet,
     * so it is owed and is written exactly as before; see `docs/wiki/protocols/mls-desync-prevention.md`.
     */
    async onBulkIngestEnd() {
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
      log?.('[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed.');
      void checkpointAfterBulkIngest().catch(() => {
        // Already logged by `flushEncryptedInternal`; swallowed here because an unawaited rejection
        // would otherwise reach the window as an unhandled one and take the pipeline down with it -
        // the exact coupling this function was changed to remove.
      });
    },
  };

  /**
   * The bulk-ingest end's checkpoint: taken when a handler marked the window, or when the proof says
   * one is owed. Unawaited by its caller, so the proof's bridge crossing does not gate delivery
   * either.
   */
  async function checkpointAfterBulkIngest(): Promise<void> {
    if (!dirtyEncrypted) {
      let owed: Awaited<ReturnType<IMlsService['checkpointOwed']>>;
      try {
        owed = await mlsService.checkpointOwed();
      } catch (e) {
        // NO PROOF IS NOT A PROOF OF NOTHING: the checkpoint is taken, as it was before the proof.
        log?.(
          `[MLS] Could not ask whether the bulk ingest owes a checkpoint (${String(e)}) - taking it.`
        );
        owed = { owed: true, by: 'state' };
      }
      if (!owed.owed) {
        log?.(
          '[MLS] Bulk ingest changed nothing durable - checkpoint skipped (the file holds it).'
        );
        return;
      }
    }
    dirtyEncrypted = true;
    await flushEncryptedInternal();
  }
}
