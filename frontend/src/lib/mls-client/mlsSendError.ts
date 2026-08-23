/**
 * Centralized classification of errors raised while SENDING an MLS application message.
 *
 * The sibling of `mlsDecryptError.ts`, and it exists for the same reason: a send failure is not one
 * thing. Everything the outbox catches used to be treated as transient and retried on a backoff
 * ladder, which is right for a network blip and wrong for an eviction - a device removed from a
 * group will be refused at every attempt, for as long as the queue entry lives.
 *
 * The classification itself is made in Rust, on the OpenMLS error VARIANT
 * (`MlsError::Evicted`, `frontend/mls-core/src/messaging.rs`), because that is where the type is
 * still available; what crosses the WASM/Tauri boundary is a string, so the variant is carried as
 * a stable machine token. This module is the single place that reads that token, exactly as
 * `classifyIncomingDecryptError` is for the receive path. Each consumer keeps its own POLICY.
 */

/** Nature of an error raised while encrypting/sending an outgoing MLS application message. */
export type MlsSendErrorKind =
  /**
   * `EVICTED`: a Remove commit naming this device was applied, so it is no longer a member. The
   * group is intact and healthy - we are simply not in it. PERMANENT: no retry, no re-add, no
   * recovery. The conversation is retired the way a peer-side deletion retires it.
   *
   * Reaching this classification at all means the eviction was not learnt from the Remove commit
   * when it merged (see `isGroupActive`), so the caller logs it as the miss it is.
   */
  | 'evicted'
  /** Everything else -> transient until proven otherwise; the caller keeps its backoff policy. */
  | 'unknown';

/**
 * Classifies a send failure into a {@link MlsSendErrorKind}.
 *
 * `EVICTED:` is emitted by `MlsError::Evicted` and by nothing else - it is not a fragment of an
 * OpenMLS message but a token this repository defines, in the same family as `UNRECOVERABLE:` and
 * `ALREADY_MEMBER:`. Matching it is therefore reading a discriminator, not parsing prose.
 */
export function classifyOutgoingSendError(error: unknown): MlsSendErrorKind {
  return String(error).includes('EVICTED:') ? 'evicted' : 'unknown';
}
