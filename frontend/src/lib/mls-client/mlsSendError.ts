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

import { GroupDeletedError, SenderNotActiveError } from './mlsDeliveryApi';

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
  /**
   * `SENDER_NOT_ACTIVE`: the SERVER refused the frame because this device's membership row is not
   * `active`, so it holds no leaf and nothing it encrypts could be opened by anyone. Not permanent -
   * a Welcome or an external commit lifts it - but NOT lifted by re-posting either, which is what
   * separates it from a network blip that shares its retry.
   *
   * Reaching it means the local MLS state and the server's roster DISAGREE about this device: the
   * outbox asked `isGroupActive` one call earlier and was told yes. That disagreement is the
   * signature of the Welcome livelock in `docs/wiki/backlog.md`, so the caller logs it as such
   * rather than as a deferral.
   */
  | 'sender-not-active'
  /**
   * `GROUP_DELETED`: the SERVER refused the frame because the group is tombstoned or absent, so it
   * is not a destination for anybody. PERMANENT, and permanent more broadly than `evicted`: there
   * is no group left to be re-admitted to.
   *
   * It is the answer to a race the client cannot win on its own - the outbox reads `deletedAt`
   * before it sends, and a deletion can land between that read and the enqueue. So reaching it is
   * not a miss the way `evicted` is; it is the seam working.
   */
  | 'group-deleted'
  /** Everything else -> transient until proven otherwise; the caller keeps its backoff policy. */
  | 'unknown';

/**
 * Classifies a send failure into a {@link MlsSendErrorKind}.
 *
 * `EVICTED:` is emitted by `MlsError::Evicted` and by nothing else - it is not a fragment of an
 * OpenMLS message but a token this repository defines, in the same family as `UNRECOVERABLE:` and
 * `ALREADY_MEMBER:`. Matching it is therefore reading a discriminator, not parsing prose.
 *
 * The server-side refusal needs no token at all: it never crosses a WASM boundary, so it arrives as
 * the TYPE the delivery API raised and is recognised as one.
 */
export function classifyOutgoingSendError(error: unknown): MlsSendErrorKind {
  if (error instanceof SenderNotActiveError) return 'sender-not-active';
  if (error instanceof GroupDeletedError) return 'group-deleted';
  return String(error).includes('EVICTED:') ? 'evicted' : 'unknown';
}
