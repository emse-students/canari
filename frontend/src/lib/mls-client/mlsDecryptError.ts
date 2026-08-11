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
  /**
   * `TooDistantInTheFuture`: the frame's generation is further ahead in the SENDER RATCHET than
   * OpenMLS will derive forward (`maximum_forward_distance`), which happens when this device missed
   * a long run of that sender's frames. Same epoch on both sides, so no commit replay can help and
   * the plaintext is gone: only a new epoch resets the ratchets. Distinct from `epoch-gap`, which
   * IS repaired by replaying commits, and from `secret-reuse`, which is behind rather than ahead.
   */
  | 'generation-gap'
  /**
   * `past epoch application frame`: an APPLICATION message from an epoch OLDER than ours, whose
   * epoch secrets this device no longer holds. `max_past_epochs` is 2, so a frame merely overtaken
   * by a commit still decrypts - reaching here means a group re-joined since (a fresh join starts
   * with no past epochs). The plaintext is gone locally for good, exactly like `secret-reuse`, and
   * exactly like it the frame is a real message rather than nothing to show: only a member holding
   * it durably can re-send it at the current epoch. Distinct from `wrong-epoch`, which is a frame
   * from an epoch AHEAD that a later load may still reach.
   */
  | 'past-epoch-application'
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
 * of these markers) EXCEPT one pair, and the order encodes it: the native layer wraps a sender-
 * ratchet failure in `GAP_QUEUED:<group>:<openmls error>`, so a `TooDistantInTheFuture` frame
 * carries both markers and must be recognised as the generation gap it is - reading it as an epoch
 * gap sends it to a commit replay that applies nothing, reports success, and ACKs the frame off the
 * server (WP-PENDING-2).
 */
export function classifyIncomingDecryptError(error: unknown): MlsDecryptErrorKind {
  const s = String(error);
  if (s.includes('CannotDecryptOwnMessage')) return 'own-message';
  if (s.includes('SecretReuseError')) return 'secret-reuse';
  if (s.includes('out of memory') || s.includes('unreachable')) return 'oom';
  if (s.includes('TooDistantInTheFuture')) return 'generation-gap';
  // Before the epoch-gap arm for the same reason `generation-gap` is: the native layer may wrap it
  // as `GAP_QUEUED:<group>:<error>`, and a commit replay repairs an epoch we are BEHIND - it can do
  // nothing for a frame from an epoch we are already PAST.
  if (s.includes('past epoch application frame')) return 'past-epoch-application';
  if (s.includes('GAP_QUEUED') || s.includes('epoch gap')) return 'epoch-gap';
  if (s.includes('WrongEpoch')) return 'wrong-epoch';
  return 'unknown';
}
