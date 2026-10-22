/**
 * The submission of a staged commit, and how its outcome is decided when no answer came back.
 *
 * ## The question a lost answer leaves open
 *
 * A structural commit is staged, submitted to the server's epoch gate, then merged on the accept or
 * cleared on the refusal (`BaseMlsService.runCommitTransaction`). When the submission gets NO
 * answer, "not landed yet" and "never landed" look the same from here: the request may still be on
 * its way, or it was taken and only its answer lost. Reading the server's commit log at that moment
 * cannot tell them apart - an empty log answers "not yet" as well as "never" - so a clear decided
 * from it races the request in flight. That is a race that heals, which is still a defect.
 *
 * ## Making the answer definitive instead
 *
 * The SAME bytes are submitted again. The gate answers a commit it already accepted from this device
 * at that base epoch as accepted again (`duplicate`), and anything else definitively:
 *
 * - accepted, first time or duplicate -> merge (and, for an Add, deliver its Welcome);
 * - refused for a reason that is an answer (another commit took the epoch, a 4xx) -> clear, catch up;
 * - still no answer -> UNKNOWN: the staged commit is KEPT and checkpointed, and nothing else is
 *   committed or sent in that group until a resubmission answers - at the next connection, the next
 *   send or commit in the group, or a replay that finds the log decided at that epoch.
 *
 * ## One store
 *
 * The submission is kept BESIDE the staged commit, in the MLS state itself
 * (`mls-core/src/pending_submission.rs`), and recorded BEFORE the first request. So the two cannot
 * disagree on disk, and a staged commit found without a submission was never sent - clearing it is
 * definitive. No clock decides anything.
 */
import type { CommitRemoval } from './mlsDeliveryApi';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';

/** One submission: everything needed to send exactly the same request again. */
export interface CommitSubmission {
  groupId: string;
  /** The epoch the commit was staged on; the gate is asked to move the group from it. */
  baseEpoch: number;
  /** The commit, base64, byte for byte the one submitted - the gate's duplicate test is equality. */
  commit: string;
  /** The external-join base for `baseEpoch + 1`, base64, as submitted. */
  groupInfo: string;
  excludeDeviceIds?: string[];
  /** The devices the commit adds - also the recipients of its Welcome. */
  admits?: Array<{ userId: string; deviceId: string }>;
  removes?: CommitRemoval[];
  /**
   * An Add's Welcome, base64. Kept because the Welcome is a SEPARATE request made after the
   * accept: a commit accepted only through a later resubmission has nobody left to send it.
   */
  welcome?: string;
}

/** Encodes a submission for the MLS state (opaque bytes there). */
export function encodeSubmission(submission: CommitSubmission): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(submission));
}

/** Decodes a submission read back from the MLS state; `null` (said loudly) when unreadable. */
export function decodeSubmission(bytes: Uint8Array): CommitSubmission | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CommitSubmission>;
    if (
      typeof parsed?.groupId !== 'string' ||
      typeof parsed.baseEpoch !== 'number' ||
      typeof parsed.commit !== 'string' ||
      typeof parsed.groupInfo !== 'string'
    ) {
      throw new Error('missing fields');
    }
    return parsed as CommitSubmission;
  } catch (e) {
    console.error('[COMMIT] a kept submission is UNREADABLE:', String(e).slice(0, 120));
    return null;
  }
}

/**
 * The commit gate gave no definitive answer to a commit of `groupId` staged on `baseEpoch`, so it is
 * neither merged nor cleared, and nothing else may be committed or sent in the group until a
 * resubmission answers.
 *
 * A {@link TransportFailureError} on purpose: the outcome is unknown BECAUSE no answer came back,
 * and every caller already reads that type as "retry when the server answers", never as final.
 */
export class CommitOutcomeUnknownError extends TransportFailureError {
  constructor(
    readonly groupId: string,
    readonly baseEpoch: number,
    cause: unknown
  ) {
    super(
      cause,
      `the commit of ${groupId.slice(0, 8)}... staged on epoch ${baseEpoch} has an UNKNOWN outcome ` +
        `(no definitive answer from the commit gate) - kept until a resubmission answers`
    );
    this.name = 'CommitOutcomeUnknownError';
  }
}

/**
 * Whether a THROWN submission is a definitive refusal: the server answered with a 4xx, which it
 * sends only before the epoch gate is reached (a malformed commit, a committer not allowed, an
 * expired token, a rate limit) - so the commit did not land. A 5xx, a gateway error or a transport
 * failure is NOT one: the advance may have committed before the answer was lost.
 */
export function isDefinitiveCommitRefusal(error: unknown): boolean {
  return error instanceof ApiRefusalError && error.status >= 400 && error.status < 500;
}

/** What the gate answered a resubmission, read the one way every caller reads it. */
export type ResubmissionVerdict = 'accepted' | 'refused' | 'unknown';

/**
 * Reads the gate's ANSWER to a resubmission.
 *
 * `concurrent_commit` is UNKNOWN on a resubmission, never a refusal: the commit lock it reports may
 * be held by this device's own original request, still being validated.
 */
export function resubmissionVerdict(answer: {
  accepted: boolean;
  reason?: string;
}): ResubmissionVerdict {
  if (answer.accepted) return 'accepted';
  return answer.reason === 'concurrent_commit' ? 'unknown' : 'refused';
}
