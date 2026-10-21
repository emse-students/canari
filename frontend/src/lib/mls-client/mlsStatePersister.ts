import type { BulkIngestPhase, IMlsService } from './IMlsService';
import { recordMlsSaveStateMs } from './catchupBenchmark';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Configuration for coalesced MLS state persistence. */
export interface MlsStatePersisterConfig {
  mlsService: IMlsService;
  log?: (msg: string) => void;
  /**
   * MEASUREMENT SWITCH, DEFAULT 0 = OFF, and off is exactly the behaviour this file always had.
   * When positive, a LIVE drain that only RECEIVED application frames (no `persistNow` and no
   * history-replay window since the last checkpoint) leaves its checkpoint to the next trigger that
   * already exists - a send, a commit, `flush` on background or logout - while fewer than this many
   * application FRAMES (ratchet generations, not drains) are unsaved, then checkpoints. A COUNT,
   * never a clock. See `receiveCheckpointSkipBudget`.
   */
  receiveSkipBudget?: number;
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
  /**
   * Called when bulk ingest ends - encrypted flush if state changed during ingest. `phase` is the
   * window's own phase; only a live drain (`bufferUi`) may ever be skipped by the measurement switch.
   */
  onBulkIngestEnd(phase?: BulkIngestPhase): Promise<void>;
}

/**
 * Creates a coalesced MLS persistence helper used by the inbound message pipeline.
 * Application-message ratchet updates are kept in WASM memory; commits and explicit
 * flush() write a checkpoint to IndexedDB, sealed with the device key.
 */
export function createMlsStatePersister(config: MlsStatePersisterConfig): MlsStatePersister {
  const { mlsService, log, receiveSkipBudget = 0 } = config;

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
  /** A commit, a Welcome or a structural change asked for durability since the last checkpoint. */
  let urgentSinceCheckpoint = false;
  /** Application frames decrypted since the last checkpoint started (ratchet generations unsaved). */
  let framesSinceCheckpoint = 0;

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
    // Reset now, restored below if the write fails: what changes DURING the write belongs to the
    // next checkpoint, but what this one was meant to cover is still owed after a failure.
    const urgentAtStart = urgentSinceCheckpoint;
    const framesAtStart = framesSinceCheckpoint;
    urgentSinceCheckpoint = false;
    framesSinceCheckpoint = 0;
    inFlightEncrypted = runSaveEncrypted()
      .catch((e) => {
        urgentSinceCheckpoint = urgentSinceCheckpoint || urgentAtStart;
        framesSinceCheckpoint += framesAtStart;
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
    framesSinceCheckpoint += 1;
  }

  function persistNow(): void {
    dirtyEncrypted = true;
    urgentSinceCheckpoint = true;
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
     */
    async onBulkIngestEnd(phase?: BulkIngestPhase) {
      // A WINDOW THAT IS NOT A LIVE DRAIN (a history replay, a restore) saves a stream cursor and
      // seen hashes of its own once it closes, which must never get ahead of the MLS state: it
      // makes the outermost close checkpoint, even when it closes inside a live drain.
      if (receiveSkipBudget > 0 && phase?.bufferUi !== true) urgentSinceCheckpoint = true;
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
      if (
        receiveSkipBudget > 0 &&
        !urgentSinceCheckpoint &&
        framesSinceCheckpoint < receiveSkipBudget
      ) {
        // Live receive-only drain with fewer unsaved frames than the budget: the state stays dirty
        // in memory and the next trigger (a send, a commit, `flush` on background or logout)
        // writes it. One drain of hundreds of frames reaches the budget and checkpoints here.
        dirtyEncrypted = true;
        console.warn(
          `[MLS] MEASUREMENT SWITCH ON: checkpoint skipped after a live receive-only drain (${framesSinceCheckpoint}/${receiveSkipBudget} frames unsaved)`
        );
        return;
      }
      log?.('[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed.');
      dirtyEncrypted = true;
      void flushEncryptedInternal().catch(() => {
        // Already logged by `flushEncryptedInternal`; swallowed here because an unawaited rejection
        // would otherwise reach the window as an unhandled one and take the pipeline down with it -
        // the exact coupling this function was changed to remove.
      });
    },
  };
}
