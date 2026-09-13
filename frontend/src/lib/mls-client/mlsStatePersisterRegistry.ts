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
 * Checkpoints MLS ratchet state after outbound traffic. Coalesced, and BEST-EFFORT.
 *
 * WHAT IT IS FOR. Encrypting a message advances the sending ratchet, and the moment that message
 * is on the wire the PEER has consumed that generation. If the advance lives only in RAM and the
 * page goes away before a checkpoint, the next load restores a ratchet BEHIND the one already
 * used: the next message is encrypted at a generation the peer has already seen, the peer raises
 * `SecretReuseError`, classifies it as a duplicate and silently drops it.
 *
 * Measured on prod 2026-08-06, deterministically: reload 300 ms after a send and the next message
 * dies (twice, at generations 118 and 120); reload 20 s after and it arrives in 694 ms. Forwarding
 * looked guilty only because opening a fresh session reloads the page - 4 losses out of 4.
 *
 * WHAT IT IS NOT. This docblock used to say the guarantee lived here, "never deferred", while the
 * body below queued the write on a microtask and returned `void` - so nothing could await it and
 * nothing did, on either platform. The claim outlived the design: the window is closed by the SEND
 * LEDGER (`sendRatchetLedger`), a synchronous `localStorage` write taken before the frame goes on
 * the wire and burnt by `reconcileSendRatchets` on the next `init`. That is the guarantee, and it
 * needs no await on the send path - which is why there is none, and why adding one would only put
 * a 1.7 s checkpoint on the latency of every message.
 *
 * So this call SHORTENS the window rather than closing it, which is worth having: a checkpoint
 * that lands means no generation to burn at all. `persistNow` merges same-tick calls and stays
 * deferred during a bulk ingest, so a burst of sends costs one checkpoint, not one per message.
 *
 * @see docs/wiki/protocols/mls-desync-prevention.md section 8
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
}

/**
 * Encrypted checkpoint after structural MLS mutations (commits, bootstrap, forget).
 * Routes through the session persister when registered; otherwise uses the fallback path.
 *
 * @returns whether a checkpoint was actually written. FALSE IS NOT AN ERROR AND IS NOT NOTHING:
 *   outside a session there is no persister and no fallback, so the call is a no-op - but a caller
 *   that asked for durability because the SERVER has already made its half of the change durable
 *   (see `BaseMlsService.externalJoin`) has not got it, and silently returning `void` gave it no
 *   way to say so. The one branch that cannot log for itself is the one that reports instead.
 */
export async function persistMlsStructuralCheckpoint(
  fallback?: MlsStructuralCheckpointFallback
): Promise<boolean> {
  if (activePersister) {
    activePersister.scheduleDeferred();
    await activePersister.flushEncrypted();
    return true;
  }
  if (!fallback) return false;
  await fallback.mlsService.persistCheckpoint();
  return true;
}
