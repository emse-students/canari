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
 *   except a `409 SEAT_CLAIM_OVERTAKEN`, which refuses only the copy that got it: the first request
 *   reads its own claim when it arrives, and may still land;
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
import { DEADLINE_MS } from '$lib/utils/requestDeadline';
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
 * `why` names the other way an outcome becomes unknown: a stage whose checkpoint threw may be on
 * disk all the same, so it is kept and settled like an unanswered one (`runCommitTransaction`).
 */
export class CommitOutcomeUnknownError extends TransportFailureError {
  constructor(
    readonly groupId: string,
    readonly baseEpoch: number,
    cause: unknown,
    why = 'no definitive answer from the commit gate'
  ) {
    super(
      cause,
      `the commit of ${groupId.slice(0, 8)}... staged on epoch ${baseEpoch} has an UNKNOWN outcome ` +
        `(${why}) - kept until a resubmission answers`
    );
    this.name = 'CommitOutcomeUnknownError';
  }
}

/**
 * A commit of `groupId` staged on `baseEpoch` was CLEARED before anything was sent: the checkpoint
 * that must carry its stage to disk first failed in a way that stored nothing (`checkpointWroteNothing`
 * - a refused write, or one that failed before anything was stored). Definitive, unlike
 * {@link CommitOutcomeUnknownError}: the commit never left, so the group is free for the next one,
 * and a checkpoint that keeps failing (a full quota) costs each commit, not every send of the session.
 */
export class CommitStageNotSavedError extends Error {
  constructor(
    readonly groupId: string,
    readonly baseEpoch: number,
    readonly cause: unknown
  ) {
    super(
      `the commit of ${groupId.slice(0, 8)}... staged on epoch ${baseEpoch} was cleared unsent: its ` +
        `checkpoint stored nothing (${String(cause).slice(0, 120)})`
    );
    this.name = 'CommitStageNotSavedError';
  }
}

/**
 * A commit of `groupId` was asked of a FOLLOWER tab, and refused before anything was staged.
 *
 * Only the leader tab runs this device's MLS state (`tabLeader.ts`): a follower holds a copy loaded
 * once, which it cannot make durable (the version guard refuses its writes once the leader has
 * written) and which the leader never learns from - the leader cannot read a commit of its own leaf
 * back (`OwnPrivateMessage`), so a commit sent from a follower moved the group past the state the
 * leader keeps. Known from leadership, which is a fact here, rather than learnt from a checkpoint
 * that fails.
 */
export class FollowerTabCommitError extends Error {
  constructor(readonly groupId: string) {
    super(
      `a commit of ${groupId.slice(0, 8)}... was asked of a follower tab - only the leader tab ` +
        'commits, so nothing was staged'
    );
    this.name = 'FollowerTabCommitError';
  }
}

/**
 * Whether a THROWN FIRST submission is a definitive refusal: the server answered with a 4xx, which
 * it sends only before the epoch gate is reached (a malformed commit, a committer not allowed, an
 * expired token, a rate limit) - so the commit did not land, and no earlier request of it exists.
 * A 5xx, a gateway error or a transport failure is NOT one: the advance may have committed before
 * the answer was lost. A RESUBMISSION reads some of these 4xx differently
 * ({@link refusesOnlyThisRequest}).
 */
export function isDefinitiveCommitRefusal(error: unknown): boolean {
  return error instanceof ApiRefusalError && error.status >= 400 && error.status < 500;
}

/**
 * Whether a 4xx answers THIS REQUEST rather than the commit's bytes: a 401 or a 403 from the auth
 * guard (a session that expired, a device revoked since, a committer no longer a member) or a 429
 * from the throttler, all given before the gate. On a resubmission they say nothing of the EARLIER
 * request of the same bytes, which may have landed - an expired session after an accepted but
 * unanswered commit is exactly that - so the outcome stays UNKNOWN, never refused.
 */
export function refusesOnlyThisRequest(error: unknown): boolean {
  return (
    error instanceof ApiRefusalError &&
    (error.status === 401 || error.status === 403 || error.status === 429)
  );
}

/**
 * The longest one commit transaction - or one settlement - holds the global MLS lock with requests
 * to the commit gate, each under the `write` head deadline: the resubmission that settles the
 * group's previous commit, then this commit's first request and the resubmission an unanswered one
 * owes. Three deadlines, derived from that deadline and never tuned apart from it. Each request's
 * own deadline adds the time its body needs to leave (`deadlineFor`), so a first request that ran to
 * its deadline leaves room for its resubmission only when no settlement request ran before it;
 * after one, the resubmission that no longer fits is not sent and the outcome stays unknown.
 *
 * A BOUND, NOT A DECISION: a resubmission the budget does not let start leaves the outcome UNKNOWN
 * (the stage kept, the next settlement decides); a first request it does not let start is never
 * sent, so its stage is cleared and the commit refused.
 */
export const COMMIT_LOCK_HOLD_BUDGET_MS = 3 * DEADLINE_MS.write;

/** The instant the lock-hold budget of a transaction entered at `now` runs out. */
export function commitLockHoldEndsAt(now: number = Date.now()): number {
  return now + COMMIT_LOCK_HOLD_BUDGET_MS;
}

/** Whether a commit-gate request, under the `write` deadline, may still start before `holdEndsAt`. */
export function mayStartCommitRequest(holdEndsAt: number, now: number = Date.now()): boolean {
  return now + DEADLINE_MS.write <= holdEndsAt;
}

/** What the gate answered a resubmission, read the one way every caller reads it. */
export type ResubmissionVerdict = 'accepted' | 'refused' | 'unknown';

/**
 * Reads the gate's ANSWER to a resubmission.
 *
 * `concurrent_commit` is UNKNOWN on a resubmission, never a refusal: the commit lock it reports may
 * be held by this device's own original request, still being validated.
 *
 * `epoch_mismatch` IS DEFINITIVE, WHATEVER EPOCH IT NAMES, because the gate answers it nowhere
 * without first asking its commit log whether THESE bytes from THIS device already landed at the
 * base (`answerIfAlreadyAccepted`, `messaging.service.ts`): at its admits pre-check, at the strict
 * gate, and when the advance was lost to another commit. That last one is the overlap the server's
 * 5 s commit lock against this client's 30 s deadline allows - our own first request, still inside
 * its transaction, taking the advance from its resubmission - and its log row is committed by the
 * time the update finds nothing to move, so the overlap is answered `duplicate`.
 */
export function resubmissionVerdict(answer: {
  accepted: boolean;
  reason?: string;
  currentEpoch?: number;
}): ResubmissionVerdict {
  if (answer.accepted) return 'accepted';
  return answer.reason === 'concurrent_commit' ? 'unknown' : 'refused';
}
