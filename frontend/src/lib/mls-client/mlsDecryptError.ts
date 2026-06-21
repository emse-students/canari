/**
 * Classification centralisee des erreurs de DECHIFFREMENT d'un message MLS entrant.
 *
 * Le meme string-matching d'erreurs OpenMLS etait duplique entre le pipeline temps-reel
 * (`handleKnownGroup` dans `setupMessageHandler.ts`) et le replay d'historique (`history.ts`).
 * Toute divergence de sous-chaine = un bug silencieux : un message recuperable marque "vu" pour
 * toujours, ou un doublon benin traite comme un hors-sync (recovery destructrice parasite). Ce
 * module est la SOURCE UNIQUE de la classification ; chaque consommateur garde ensuite sa propre
 * POLITIQUE (ACK, escalade gap, retry, mark-seen), qui differe legitimement selon le contexte.
 *
 * Note : la couche native Rust (`frontend/src-tauri/src/lib.rs`) classe les cas same-epoch benins
 * a la source (Passe 1) et reste hors de ce module - process distinct, pas de partage de code TS.
 */

/** Nature d'une erreur remontee par le dechiffrement d'un message applicatif MLS entrant. */
export type MlsDecryptErrorKind =
  /** `CannotDecryptOwnMessage` : frame chiffree par/pour un autre device -> benin (ACK/skip). */
  | 'own-message'
  /** `SecretReuseError` : cle de generation deja consommee (doublon) -> benin, jamais recuperable. */
  | 'secret-reuse'
  /** `GAP_QUEUED` (Tauri/SQLite) ou `epoch gap` (web) : commit manquant -> recuperable a l'arrivee des commits. */
  | 'epoch-gap'
  /** `WrongEpoch` : frame d'une epoch pas encore atteinte par CE flux -> recuperable a un load ulterieur. */
  | 'wrong-epoch'
  /** `out of memory` / `unreachable` : panique WASM -> fatal. */
  | 'oom'
  /** Tout le reste -> hors-sync probable ; la politique (re-add, log) est a la charge de l'appelant. */
  | 'unknown';

/**
 * Classe l'erreur de dechiffrement d'un message entrant en {@link MlsDecryptErrorKind}.
 *
 * Les sous-chaines reconnues sont mutuellement exclusives en pratique (une erreur OpenMLS ne porte
 * qu'un seul de ces marqueurs) ; l'ordre ci-dessous ne sert qu'a un determinisme stable.
 */
export function classifyIncomingDecryptError(error: unknown): MlsDecryptErrorKind {
  const s = String(error);
  if (s.includes('CannotDecryptOwnMessage')) return 'own-message';
  if (s.includes('SecretReuseError')) return 'secret-reuse';
  if (s.includes('out of memory') || s.includes('unreachable')) return 'oom';
  if (s.includes('GAP_QUEUED') || s.includes('epoch gap')) return 'epoch-gap';
  if (s.includes('WrongEpoch')) return 'wrong-epoch';
  return 'unknown';
}
