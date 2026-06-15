import type { IMlsService } from './IMlsService';
import { recordMlsSaveStateMs } from './catchupBenchmark';
import { saveMlsStateEncrypted } from '$lib/utils/hex';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Configuration for coalesced MLS state persistence. */
export interface MlsStatePersisterConfig {
  mlsService: IMlsService;
  pin: string;
  userId: string;
  log?: (msg: string) => void;
}

/**
 * Coalesced MLS state writer.
 * Routine ratchet advances stay in WASM memory; only PIN-encrypted checkpoints hit disk.
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
 * flush() write an encrypted checkpoint (Argon2) to IndexedDB.
 */
export function createMlsStatePersister(config: MlsStatePersisterConfig): MlsStatePersister {
  const { mlsService, pin, userId, log } = config;

  let dirtyEncrypted = false;
  let immediateFlushQueued = false;
  let inFlightEncrypted: Promise<void> | null = null;
  let rerunEncryptedAfterFlight = false;
  let bulkIngestDepth = 0;

  async function runSaveEncrypted(): Promise<void> {
    await yieldToMainThread();
    const saveStarted = typeof performance !== 'undefined' ? performance.now() : null;
    const bytes = await mlsService.saveState(pin);
    if (saveStarted !== null) {
      recordMlsSaveStateMs(performance.now() - saveStarted);
    }
    await saveMlsStateEncrypted(userId, bytes);
    log?.('[MLS] État MLS persisté (chiffré)');
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
        log?.(`[MLS] Échec persistance chiffrée: ${msg}`);
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
      log?.(`[MLS] Persistance différée (bulk ingest depth=${bulkIngestDepth})`);
    },
    async onBulkIngestEnd() {
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
      log?.('[MLS] Fin bulk ingest - flush chiffré MLS si nécessaire');
      dirtyEncrypted = true;
      await flushEncryptedInternal();
    },
  };
}
