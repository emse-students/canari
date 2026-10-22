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
 * ## One store, one call
 *
 * The record is kept BESIDE the staged commit, in the MLS state itself
 * (`mls-core/src/pending_submission.rs`), and written by the SAME platform call that stages the
 * commit, from the client's {@link CommitIntent} and the stage's own output. A checkpoint does not
 * take the MLS lock, so it can run between any two calls the client makes; one call leaves it no
 * moment to export a staged commit without its record. A staged commit found with no record was
 * therefore never submitted through the gate, and clearing it is definitive. No clock decides
 * anything.
 */
import { commitAdmits } from './commitAdmits';
import type { CommitRemoval } from './mlsDeliveryApi';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { toBase64 } from '$lib/utils/hex';
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

/**
 * What this client says about a commit BEFORE it is staged, handed to the stage itself so the
 * platform records it with the commit in one call. Everything else a submission carries is the
 * stage's own output.
 */
export interface CommitIntent {
  groupId: string;
  /** This device, `userId:deviceId` - never one of the commit's admits. */
  self: string;
  excludeDeviceIds?: string[];
  removes?: CommitRemoval[];
  /** For an Add of several devices: the device of each key package, by position. */
  keyPackageDevices?: string[];
}

/** Encodes an intent for the stage (opaque bytes to the platform). */
export function encodeIntent(intent: CommitIntent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(intent));
}

/** A staged commit's record, as the platform wrote it in the same call that staged it. */
export interface StagedRecord {
  intent: Uint8Array;
  baseEpoch: number;
  commit: Uint8Array;
  groupInfo: Uint8Array;
  welcome?: Uint8Array;
  addedIndices: number[];
}

/**
 * What a group's state says about its staged commit's record: none (no staged commit, or one that
 * never went through the gate), unreadable (a record that does not decode - the outcome is NOT known
 * from it), or the record itself.
 */
export type PendingSubmissionRead =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'recorded'; record: StagedRecord };

/**
 * An Add's Welcome a settlement still owes, kept in the MLS state until each recipient is sent it
 * (`mls-core/src/owed_welcome.rs`). The tree is the one of the epoch the Add created, captured at
 * the merge.
 */
export interface OwedWelcome {
  groupId: string;
  welcome: Uint8Array;
  ratchetTree: Uint8Array;
  /** `userId:deviceId` of every device not yet sent it. */
  recipients: string[];
}

/**
 * The submission a record describes - the ONE spelling of it, used for the first request and for
 * every resubmission alike, so both are the same bytes. `null` (said loudly) when its intent does
 * not decode: the record is then unreadable, never "absent".
 */
export function composeSubmission(record: StagedRecord): CommitSubmission | null {
  let intent: CommitIntent;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(record.intent)) as Partial<CommitIntent>;
    if (typeof parsed?.groupId !== 'string' || typeof parsed.self !== 'string') {
      throw new Error('missing fields');
    }
    intent = parsed as CommitIntent;
  } catch (e) {
    console.error('[COMMIT] the intent of a staged commit is UNREADABLE:', String(e).slice(0, 120));
    return null;
  }
  // The devices this commit adds, recorded by the server WITH the advance (`commitAdmits`).
  const admits = commitAdmits(
    intent.excludeDeviceIds,
    intent.keyPackageDevices
      ? record.addedIndices.map((i) => intent.keyPackageDevices![i])
      : undefined,
    intent.self
  );
  return {
    groupId: intent.groupId,
    baseEpoch: record.baseEpoch,
    commit: toBase64(record.commit),
    groupInfo: toBase64(record.groupInfo),
    ...(intent.excludeDeviceIds ? { excludeDeviceIds: intent.excludeDeviceIds } : {}),
    ...(admits.length > 0 ? { admits } : {}),
    ...(intent.removes ? { removes: intent.removes } : {}),
    ...(record.welcome ? { welcome: toBase64(record.welcome) } : {}),
  };
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
