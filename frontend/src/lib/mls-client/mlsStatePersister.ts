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
    if (saveStarted !== null) {
      recordMlsSaveStateMs(performance.now() - saveStarted);
    }
    await saveMlsStateEncrypted(userId, bytes);
    log?.('[MLS] Encrypted state checkpoint persisted.');
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
    async onBulkIngestEnd() {
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
      log?.('[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed.');
      dirtyEncrypted = true;
      await flushEncryptedInternal();
    },
  };
}
