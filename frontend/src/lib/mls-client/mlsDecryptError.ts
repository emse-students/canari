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
  /**
   * `EVICTED`: a frame for a group this device has been REMOVED from. Not a decryption failure -
   * the Remove commit retired our leaf, and the frame was in flight or routed by a server registry
   * the removal had not finished cleaning. ACKed and dropped, and it is the ONE kind here that must
   * not reach the out-of-sync policy: recovery asks to be re-added to a group we were deliberately
   * removed from, and the commit request that follows can only ever be refused.
   */
  | 'evicted'
  /** `out of memory` / `unreachable`: WASM panic -> fatal. */
  | 'oom'
  /**
   * `same-epoch refusal`: the frame was refused at EXACTLY the epoch it names, which `mls-core`
   * knows before it calls `process_message` and nobody downstream can re-derive. It is what is
   * left of the decrypt path once every ratchet kind above has taken what it recognises, and it is
   * permanent by proof rather than by observation: an epoch's tree is fixed once the epoch exists,
   * and the past-epoch secrets a later attempt would read are the same ones - so the same bytes
   * are refused identically for ever, whatever arrives in between.
   *
   * It is therefore ACKed like `secret-reuse`, and it is a REAL MESSAGE rather than nothing to
   * show, so a consumer that reconciles losses counts it as one. Distinct from `unknown`, which it
   * was indistinguishable from until 2026-08-27: an unacknowledged distribution frame comes back
   * on every connection for ever, and one `InvalidSignature` at epoch 0 dirtied eleven cells of a
   * campaign rung that way (COMM, prod 2026-08-26).
   */
  | 'same-epoch-refusal'
  /** Everything else -> likely out-of-sync; the policy (re-add, log) is up to the caller. */
  | 'unknown';

/**
 * Classifies an incoming message's decryption error into a {@link MlsDecryptErrorKind}.
 *
 * THE ORDER IS THE CONTRACT, NOT A TIDYING. Most of these markers are mutually exclusive, but two
 * mechanisms put two of them on one string, and both put the WRONG one last. The native layer
 * wraps anything it does not recognise as `GAP_QUEUED:<group>:<openmls error>`, so a
 * `TooDistantInTheFuture` frame carries the gap marker too - and reading it as an epoch gap sends
 * it to a commit replay that applies nothing, reports success, and ACKs the frame off the server
 * (WP-PENDING-2). And `mls-core` embeds the raw OpenMLS error inside its own `same-epoch refusal`,
 * so a spent generation or a too-far-ahead one carries that marker as well. In both cases the
 * SPECIFIC marker names the ratchet position and must be tested first; the general one says only
 * what is left when none of them applies.
 */
export function classifyIncomingDecryptError(error: unknown): MlsDecryptErrorKind {
  const s = String(error);
  // FIRST, because it is the only kind here that is not about the frame at all but about our
  // membership - and because the fall-through it used to take (`unknown` -> out-of-sync -> re-add)
  // is the single most destructive answer of the set.
  if (s.includes('EVICTED:')) return 'evicted';
  if (s.includes('CannotDecryptOwnMessage')) return 'own-message';
  if (s.includes('SecretReuseError')) return 'secret-reuse';
  if (s.includes('out of memory') || s.includes('unreachable')) return 'oom';
  if (s.includes('TooDistantInTheFuture')) return 'generation-gap';
  // Before the epoch-gap arm for the same reason `generation-gap` is: the native layer may wrap it
  // as `GAP_QUEUED:<group>:<error>`, and a commit replay repairs an epoch we are BEHIND - it can do
  // nothing for a frame from an epoch we are already PAST.
  if (s.includes('past epoch application frame')) return 'past-epoch-application';
  // BEFORE THE EPOCH-GAP ARM, for the third time on this list and for the third distinct reason.
  // `mls-core` emits this marker from the same return as `TooDistantInTheFuture` and
  // `SecretReuseError`, so those two are checked above and win; and the NATIVE layer wraps
  // whatever it does not recognise as `GAP_QUEUED:<group>:<error>`, so reading this frame below
  // would send a permanent refusal through a commit replay that applies nothing and reports
  // success - WP-PENDING-2's shape exactly, one classification later.
  if (s.includes('same-epoch refusal')) return 'same-epoch-refusal';
  if (s.includes('GAP_QUEUED') || s.includes('epoch gap')) return 'epoch-gap';
  if (s.includes('WrongEpoch')) return 'wrong-epoch';
  return 'unknown';
}
