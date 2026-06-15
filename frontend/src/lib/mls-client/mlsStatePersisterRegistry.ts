import type { MlsStatePersister } from './mlsStatePersister';

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
 * Marks MLS ratchet state dirty in RAM after outbound traffic.
 * Disk is touched only on an encrypted checkpoint (background, logout, commits, bulk end).
 */
export function scheduleOutboundMlsPersist(): void {
  activePersister?.scheduleDeferred();
}

/** Flushes the encrypted MLS checkpoint if a persister is registered (logout / background). */
export async function flushActiveMlsStateEncrypted(): Promise<void> {
  await activePersister?.flushEncrypted();
}
