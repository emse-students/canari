import type { IMlsService } from './IMlsService';
import { saveMlsState } from '$lib/utils/hex';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Configuration for coalesced MLS state persistence. */
export interface MlsStatePersisterConfig {
  mlsService: IMlsService;
  pin: string;
  userId: string;
  log?: (msg: string) => void;
  /** Debounce for non-commit traffic (application messages). */
  deferredMs?: number;
}

/** Coalesced MLS state writer — batches saveState calls to reduce Argon2/WASM pressure on the UI thread. */
export interface MlsStatePersister {
  /** Marks state dirty and flushes soon (same-tick calls are merged). */
  persistNow(): void;
  /** Marks state dirty and schedules a debounced flush. */
  scheduleDeferred(): void;
  /** Flushes immediately if dirty; returns the in-flight save promise. */
  flush(): Promise<void>;
  /** Called when bulk message ingest starts — defers disk writes until ingest ends. */
  onBulkIngestStart(): void;
  /** Called when bulk ingest ends — flushes once if state changed during ingest. */
  onBulkIngestEnd(): Promise<void>;
}

const DEFAULT_DEFERRED_MS = 8_000;

/**
 * Creates a coalesced MLS persistence helper used by the inbound message pipeline.
 * Commits and explicit flush() still persist promptly; application-message ratchet
 * updates are debounced to avoid Argon2 on every message during catch-up.
 */
export function createMlsStatePersister(config: MlsStatePersisterConfig): MlsStatePersister {
  const { mlsService, pin, userId, log } = config;
  const deferredMs = config.deferredMs ?? DEFAULT_DEFERRED_MS;

  let dirty = false;
  let deferredTimer: ReturnType<typeof setTimeout> | null = null;
  let immediateFlushQueued = false;
  let inFlight: Promise<void> | null = null;
  let rerunAfterFlight = false;
  let bulkIngestDepth = 0;

  function clearDeferredTimer(): void {
    if (deferredTimer !== null) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
  }

  async function runSave(): Promise<void> {
    await yieldToMainThread();
    if (typeof requestIdleCallback === 'function') {
      await new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 5_000 });
      });
    }
    const bytes = await mlsService.saveState(pin);
    await saveMlsState(userId, bytes);
    log?.('[MLS] État MLS persisté (coalescé)');
  }

  async function flushInternal(): Promise<void> {
    if (!dirty) return;
    if (inFlight) {
      rerunAfterFlight = true;
      return inFlight;
    }

    dirty = false;
    inFlight = runSave()
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        log?.(`[MLS] Échec persistance état: ${msg}`);
        console.warn('[MLS] state persist failed:', e);
      })
      .finally(() => {
        inFlight = null;
        if (rerunAfterFlight) {
          rerunAfterFlight = false;
          if (dirty) void flushInternal();
        }
      });

    return inFlight;
  }

  function scheduleDeferred(): void {
    dirty = true;
    if (bulkIngestDepth > 0) return;
    if (deferredTimer !== null) return;
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      void flushInternal();
    }, deferredMs);
  }

  function persistNow(): void {
    dirty = true;
    clearDeferredTimer();
    if (bulkIngestDepth > 0) return;
    if (immediateFlushQueued) return;
    immediateFlushQueued = true;
    queueMicrotask(() => {
      immediateFlushQueued = false;
      void flushInternal();
    });
  }

  return {
    persistNow,
    scheduleDeferred,
    flush: flushInternal,
    onBulkIngestStart() {
      bulkIngestDepth += 1;
      clearDeferredTimer();
      log?.(`[MLS] Persistance différée (bulk ingest depth=${bulkIngestDepth})`);
    },
    async onBulkIngestEnd() {
      bulkIngestDepth = Math.max(0, bulkIngestDepth - 1);
      if (bulkIngestDepth > 0) return;
      log?.('[MLS] Fin bulk ingest — flush persistance MLS si nécessaire');
      await flushInternal();
    },
  };
}
