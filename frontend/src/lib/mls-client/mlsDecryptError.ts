/**
 * Centralized classification of DECRYPTION errors for an incoming MLS message.
 *
 * The same OpenMLS error string-matching used to be duplicated between the real-time pipeline
 * (`handleKnownGroup` in `setupMessageHandler.ts`) and the history replay (`history.ts`).
 * Any substring divergence is a silent bug: a recoverable message marked "seen" forever, or a
 * benign duplicate treated as an out-of-sync (spurious destructive recovery). This module is the
 * SINGLE SOURCE of the classification; each consumer then keeps its own POLICY (ACK, gap
 * escalation, retry, mark-seen), which legitimately differs by context.
 *
 * Note: the native Rust layer (`frontend/src-tauri/src/lib.rs`) classifies benign same-epoch cases
 * at the source (Pass 1) and stays outside this module - separate process, no shared TS code.
 */

/** Nature of an error raised while decrypting an incoming MLS application message. */
export type MlsDecryptErrorKind =
  /** `CannotDecryptOwnMessage`: frame encrypted by/for another device -> benign (ACK/skip). */
  | 'own-message'
  /** `SecretReuseError`: generation key already consumed (duplicate) -> benign, never recoverable. */
  | 'secret-reuse'
  /** `GAP_QUEUED` (Tauri/SQLite) or `epoch gap` (web): missing commit -> recoverable once commits arrive. */
  | 'epoch-gap'
  /** `WrongEpoch`: frame from an epoch not yet reached by THIS stream -> recoverable on a later load. */
  | 'wrong-epoch'
  /** `out of memory` / `unreachable`: WASM panic -> fatal. */
  | 'oom'
  /** Everything else -> likely out-of-sync; the policy (re-add, log) is up to the caller. */
  | 'unknown';

/**
 * Classifies an incoming message's decryption error into a {@link MlsDecryptErrorKind}.
 *
 * The recognized substrings are mutually exclusive in practice (an OpenMLS error carries only one
 * of these markers); the order below only exists for stable determinism.
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
