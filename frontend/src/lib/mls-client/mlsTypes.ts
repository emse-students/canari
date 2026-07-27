/**
 * Types shared by the pipeline, the recovery and the connection layers.
 *
 * Principle: `getLocalGroups()` is the only source of truth for whether a device is in a group.
 * These types describe the outcome of processing incoming messages on the client side.
 */

/**
 * Server-side membership state of a device in a group.
 *
 * - `pending`: the device has not processed a Welcome for this group yet.
 * - `active` : the device processed its Welcome and is in sync.
 */
export type MembershipStatus = 'pending' | 'active';

/**
 * Résultat typé du traitement d'un message MLS entrant.
 *
 * Replaces the ambiguous `Uint8Array | null` return of `processIncomingMessage`.
 * Produced by interpreting the WASM output plus the deduplication flags.
 */
export type ProcessResult =
  | { kind: 'ok'; content: Uint8Array }
  | { kind: 'duplicate' } // message déjà vu (WASM duplicate flag)
  | { kind: 'own_message' } // CannotDecryptOwnMessage - ignorer
  | { kind: 'out_of_sync' }; // epoch décalée ou déchiffrement impossible
