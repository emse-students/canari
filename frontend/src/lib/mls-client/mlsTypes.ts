/**
 * Types partagés par le pipeline, la recovery et la connection.
 *
 * Principe : `getLocalGroups()` est la seule source de vérité pour savoir
 * si un device est dans un groupe. Ces types décrivent le résultat du
 * traitement des messages entrants côté client.
 */

/**
 * État de membership d'un device dans un groupe, côté serveur.
 *
 * - `pending` : le device n'a pas encore traité de Welcome pour ce groupe.
 * - `active`  : le device a traité son Welcome et est en sync.
 */
export type MembershipStatus = 'pending' | 'active';

/**
 * Résultat typé du traitement d'un message MLS entrant.
 *
 * Remplace le retour `Uint8Array | null` ambigu de `processIncomingMessage`.
 * Produit en interprétant la sortie WASM + les flags de déduplication.
 */
export type ProcessResult =
  | { kind: 'ok'; content: Uint8Array }
  | { kind: 'duplicate' } // message déjà vu (WASM duplicate flag)
  | { kind: 'own_message' } // CannotDecryptOwnMessage - ignorer
  | { kind: 'out_of_sync' }; // epoch décalée ou déchiffrement impossible
