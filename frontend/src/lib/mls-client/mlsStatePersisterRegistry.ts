import type { MlsStatePersister } from './mlsStatePersister';
import type { IMlsService } from './IMlsService';

/**
 * Process-wide handle to the session's MLS state persister.
 *
 * Outbound message helpers and lifecycle hooks reach the persister through this registry
 * rather than threading it everywhere. It is registered when the message pipeline starts
 * and cleared on logout, so the free functions below become safe no-ops outside a session.
 */
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
 * Checkpoints MLS ratchet state after outbound traffic. Coalesced, but never deferred.
 *
 * THIS MUST HIT DISK, and the reason is not performance hygiene - it is correctness. Encrypting a
 * message advances the sending ratchet, and the moment that message is on the wire the PEER has
 * consumed that generation. If the advance lives only in RAM and the page goes away before a
 * checkpoint, the next load restores a ratchet BEHIND the one already used: the next message is
 * encrypted at a generation the peer has already seen, the peer raises `SecretReuseError`,
 * classifies it as a duplicate and silently drops it. The message is lost with no error anywhere.
 *
 * Measured on prod 2026-08-06, deterministically: reload 300 ms after a send and the next message
 * dies (twice, at generations 118 and 120); reload 20 s after and it arrives in 694 ms. Forwarding
 * looked guilty only because opening a fresh session reloads the page - 4 losses out of 4.
 *
 * The `pagehide` / `visibilitychange` hooks in `mlsStatePersisterLifecycle` cannot cover this: they
 * can only start an async save (`saveState` is a worker round trip, then IndexedDB) and the
 * document is torn down long before it lands. An unload hook is a best-effort extra, never the
 * guarantee. The guarantee has to be here, at the point the ratchet moved.
 *
 * `persistNow` still merges same-tick calls and stays deferred during a bulk ingest, so a burst of
 * sends costs one checkpoint, not one per message.
 */
export function scheduleOutboundMlsPersist(): void {
  activePersister?.persistNow();
}

/** Flushes the encrypted MLS checkpoint if a persister is registered (logout / background). */
export async function flushActiveMlsStateEncrypted(): Promise<void> {
  await activePersister?.flushEncrypted();
}

/** Fallback when the registry persister is not registered (tests / pre-pipeline). */
export interface MlsStructuralCheckpointFallback {
  mlsService: Pick<IMlsService, 'persistCheckpoint'>;
  deviceKeyB64: string;
}

/**
 * Encrypted checkpoint after structural MLS mutations (commits, bootstrap, forget).
 * Routes through the session persister when registered; otherwise uses the fallback path.
 */
export async function persistMlsStructuralCheckpoint(
  fallback?: MlsStructuralCheckpointFallback
): Promise<void> {
  if (activePersister) {
    activePersister.scheduleDeferred();
    await activePersister.flushEncrypted();
    return;
  }
  if (!fallback) return;
  await fallback.mlsService.persistCheckpoint(fallback.deviceKeyB64);
}
