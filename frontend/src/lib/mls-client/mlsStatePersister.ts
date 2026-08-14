import type { IMlsService } from './IMlsService';
import { recordMlsSaveStateMs } from './catchupBenchmark';
import { saveMlsStateEncrypted } from '$lib/utils/hex';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Configuration for coalesced MLS state persistence. */
export interface MlsStatePersisterConfig {
  mlsService: IMlsService;
  deviceKeyB64: string;
  userId: string;
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
  const { mlsService, deviceKeyB64, userId, log } = config;

  let dirtyEncrypted = false;
  let immediateFlushQueued = false;
  let inFlightEncrypted: Promise<void> | null = null;
  let rerunEncryptedAfterFlight = false;
  let bulkIngestDepth = 0;

  async function runSaveEncrypted(): Promise<void> {
    await yieldToMainThread();
    const saveStarted = typeof performance !== 'undefined' ? performance.now() : null;
    const bytes = await mlsService.saveState(deviceKeyB64);
    // THE TWO HALVES ARE PRICED SEPARATELY, because they are not the same thing and only one of them
    // is what a reload reads back. `saveState` serialises the client and, on native, writes
    // `mls.bin`; `saveMlsStateEncrypted` seals a copy into IndexedDB behind Argon2. The whole
    // checkpoint was measured at 3.2 s on the phone on 2026-08-14 - which decides nothing on its
    // own, because the question "may a send WAIT for the state to be durable" is a question about
    // the first half alone. The metric existed (`recordMlsSaveStateMs`) and was never printed, so
    // the number had to be guessed; it was guessed wrong by a factor of forty.
    const saveMs = saveStarted === null ? null : performance.now() - saveStarted;
    if (saveMs !== null) recordMlsSaveStateMs(saveMs);
    await saveMlsStateEncrypted(userId, bytes);
    const totalMs = saveStarted === null ? null : performance.now() - saveStarted;
    log?.(
      `[MLS] Encrypted state checkpoint persisted.${
        saveMs === null || totalMs === null
          ? ''
          : ` (saveState ${Math.round(saveMs)} ms of ${Math.round(totalMs)} ms total)`
      }`
    );
  }

  async function flushEncryptedInternal(): Promise<void> {
    if (!dirtyEncrypted) return;
    if (inFlightEncrypted) {
      rerunEncryptedAfterFlight = true;
      return inFlightEncrypted;
    }

    dirtyEncrypted = false;
    inFlightEncrypted = runSaveEncrypted()
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        log?.(`[MLS] Encrypted state checkpoint failed: ${msg}`);
        throw e;
      })
      .finally(() => {
        inFlightEncrypted = null;
        if (rerunEncryptedAfterFlight) {
          rerunEncryptedAfterFlight = false;
          if (dirtyEncrypted) void flushEncryptedInternal();
        }
      });

    return inFlightEncrypted;
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
      void flushEncryptedInternal();
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
    async onBulkIngestEnd() {
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
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
