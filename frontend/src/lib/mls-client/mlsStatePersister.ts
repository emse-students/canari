import type { IMlsService } from './IMlsService';
import { saveMlsStateEncrypted, saveMlsStatePlain } from '$lib/utils/hex';
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

/** Redis stream page size returned by `GET /api/mls/history/:groupId` (matches server COUNT). */
export const MLS_HISTORY_PAGE_SIZE = 1000;

let activePersister: MlsStatePersister | null = null;

/** Registers the session MLS state persister (called from `setupMessageHandler`). */
export function registerMlsStatePersister(persister: MlsStatePersister): void {
  activePersister = persister;
}

/** Clears the active persister on logout so outbound hooks become no-ops. */
export function unregisterMlsStatePersister(): void {
  activePersister = null;
}

/**
 * Schedules a coalesced MLS state save after outbound traffic that advances the ratchet.
 * No-op when no handler is registered (unit tests, pre-login).
 */
export function scheduleOutboundMlsPersist(): void {
  activePersister?.scheduleDeferred();
}

/** Flushes the encrypted MLS checkpoint if a persister is registered (logout / background). */
export async function flushActiveMlsStateEncrypted(): Promise<void> {
  await activePersister?.flushEncrypted();
}

/** Coalesced MLS state writer with two-tier persistence (plain CBOR + encrypted checkpoint). */
export interface MlsStatePersister {
  /** Marks state dirty and flushes encrypted soon (same-tick calls are merged). */
  persistNow(): void;
  /** Marks state dirty and schedules a debounced plain CBOR flush. */
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

// 2s pour les messages applicatifs (ratchet advance) - fenêtre de perte réduite vs 8s initial.
// Les commits sont persistés immédiatement via persistNow() (chiffré) et n'atteignent pas ce timer.
const DEFAULT_DEFERRED_MS = 2_000;

/**
 * Creates a coalesced MLS persistence helper used by the inbound message pipeline.
 * Commits and explicit flush() write an encrypted checkpoint; routine ratchet updates
 * are debounced to plain CBOR to avoid Argon2 on every message during catch-up.
 */
export function createMlsStatePersister(config: MlsStatePersisterConfig): MlsStatePersister {
  const { mlsService, pin, userId, log } = config;
  const deferredMs = config.deferredMs ?? DEFAULT_DEFERRED_MS;

  let dirtyPlain = false;
  let dirtyEncrypted = false;
  let deferredTimer: ReturnType<typeof setTimeout> | null = null;
  let immediateFlushQueued = false;
  let inFlightPlain: Promise<void> | null = null;
  let inFlightEncrypted: Promise<void> | null = null;
  let rerunPlainAfterFlight = false;
  let rerunEncryptedAfterFlight = false;
  let bulkIngestDepth = 0;

  function clearDeferredTimer(): void {
    if (deferredTimer !== null) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
  }

  async function runSavePlain(): Promise<void> {
    await yieldToMainThread();
    const bytes = await mlsService.saveStatePlain();
    await saveMlsStatePlain(userId, bytes);
    log?.('[MLS] État MLS persisté (CBOR plain, coalescé)');
  }

  async function runSaveEncrypted(): Promise<void> {
    await yieldToMainThread();
    const bytes = await mlsService.saveState(pin);
    await saveMlsStateEncrypted(userId, bytes);
    log?.('[MLS] État MLS persisté (chiffré)');
  }

  async function flushPlainInternal(): Promise<void> {
    if (!dirtyPlain) return;
    if (inFlightPlain) {
      rerunPlainAfterFlight = true;
      return inFlightPlain;
    }

    dirtyPlain = false;
    inFlightPlain = runSavePlain()
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        log?.(`[MLS] Échec persistance plain: ${msg}`);
        throw e;
      })
      .finally(() => {
        inFlightPlain = null;
        if (rerunPlainAfterFlight) {
          rerunPlainAfterFlight = false;
          if (dirtyPlain) void flushPlainInternal();
        }
      });

    return inFlightPlain;
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
    dirtyPlain = true;
    dirtyEncrypted = true;
    if (bulkIngestDepth > 0) return;
    if (deferredTimer !== null) return;
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      void flushPlainInternal();
    }, deferredMs);
  }

  function persistNow(): void {
    dirtyEncrypted = true;
    dirtyPlain = true;
    clearDeferredTimer();
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
      clearDeferredTimer();
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
