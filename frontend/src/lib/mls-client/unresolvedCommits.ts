/**
 * A commit this device submitted and whose outcome it does not know - and the one way it learns it.
 *
 * ## The question a lost answer leaves open
 *
 * A structural commit is staged, submitted to the server's epoch gate, then merged on the accept or
 * cleared on the refusal (`BaseMlsService.runCommitTransaction`). When the submission gets NO
 * answer, "not landed yet" and "never landed" look the same from here: the request may still be on
 * its way, or it may have been taken and only its answer lost. Reading the server's commit log at
 * that moment cannot tell them apart - an empty log answers "not yet" as well as "never" - so a
 * clear decided from it races the in-flight request, and the commit the device just threw away may
 * be accepted a second later. That is a race that heals (the recovery ladder rebuilds the device),
 * which is still a defect.
 *
 * ## Making the answer definitive instead
 *
 * The SAME bytes are submitted again. The gate answers a commit it already accepted from this device
 * at that base epoch as accepted again (`duplicate`), and anything else definitively:
 *
 * - accepted, first time or duplicate -> merge;
 * - refused for a reason that is an answer (another commit took the epoch, a 4xx) -> clear, catch up;
 * - still no answer -> the outcome stays UNKNOWN: the staged commit is KEPT (and checkpointed), the
 *   submission is recorded here, durably, and nothing else is committed or sent in that group until
 *   a later resubmission answers. That resubmission runs at the next connection, before the next
 *   send or commit in the group, and before a commit replay reads the group's log.
 *
 * No clock decides anything: the record is resolved only by an answer from the gate, or by the log
 * holding a commit AT the record's base epoch, which is decided for good (the log row is unique per
 * base epoch and written in the advance's transaction).
 */
import type { CommitRemoval } from './mlsDeliveryApi';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';

/** One submission whose outcome is unknown: everything needed to send exactly the same request. */
export interface UnresolvedCommit {
  groupId: string;
  /** The epoch the commit was staged on; the gate is asked to move the group from it. */
  baseEpoch: number;
  /** The commit, base64, byte for byte the one submitted - the gate's duplicate test is equality. */
  commit: string;
  /** The external-join base for `baseEpoch + 1`, base64, as submitted. */
  groupInfo: string;
  excludeDeviceIds?: string[];
  admits?: Array<{ userId: string; deviceId: string }>;
  removes?: CommitRemoval[];
  /** When the outcome became unknown (ms). For the log only - never read by a decision. */
  at: number;
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

function storageKey(userId: string, deviceId: string): string {
  return ACCOUNT_KEY.unresolvedCommits(userId, deviceId);
}

/**
 * Every unresolved commit of this account on this device, by group. An unreadable store reads as
 * empty and says so: the staged commit it names then stays pending in the group until the read
 * side's replay finds the log decided at its base epoch.
 */
export function readUnresolvedCommits(
  userId: string,
  deviceId: string
): Record<string, UnresolvedCommit> {
  try {
    const raw = localStorage.getItem(storageKey(userId, deviceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, UnresolvedCommit>;
  } catch (e) {
    console.error(
      `[COMMIT] the unresolved-commit record of ${userId.slice(0, 8)}... is UNREADABLE - read as ` +
        'empty, so no resubmission settles what it named:',
      String(e).slice(0, 120)
    );
    return {};
  }
}

/** The unresolved commit of `groupId`, or `null` when its last commit's outcome is known. */
export function unresolvedCommitFor(
  userId: string,
  deviceId: string,
  groupId: string
): UnresolvedCommit | null {
  return readUnresolvedCommits(userId, deviceId)[groupId] ?? null;
}

function write(userId: string, deviceId: string, all: Record<string, UnresolvedCommit>): boolean {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(storageKey(userId, deviceId));
    else localStorage.setItem(storageKey(userId, deviceId), JSON.stringify(all));
    return true;
  } catch (e) {
    console.error(
      `[COMMIT] could not write the unresolved-commit record of ${userId.slice(0, 8)}...:`,
      String(e).slice(0, 120)
    );
    return false;
  }
}

/**
 * Records `commit` as unresolved. Returns false when the write failed - the caller then cannot keep
 * the staged commit, since nothing would settle it after a reload.
 */
export function recordUnresolvedCommit(
  userId: string,
  deviceId: string,
  commit: UnresolvedCommit
): boolean {
  const all = readUnresolvedCommits(userId, deviceId);
  all[commit.groupId] = commit;
  const ok = write(userId, deviceId, all);
  if (ok) {
    console.warn(
      `[COMMIT] ${commit.groupId.slice(0, 8)}... commit from epoch ${commit.baseEpoch} recorded ` +
        'UNRESOLVED - the group takes no commit and no send until a resubmission answers'
    );
  }
  return ok;
}

/** Forgets the unresolved commit of `groupId`, once its outcome is known (or moot), saying which. */
export function forgetUnresolvedCommit(
  userId: string,
  deviceId: string,
  groupId: string,
  outcome: string
): void {
  const all = readUnresolvedCommits(userId, deviceId);
  if (!(groupId in all)) return;
  const { baseEpoch } = all[groupId];
  delete all[groupId];
  write(userId, deviceId, all);
  console.log(
    `[COMMIT] ${groupId.slice(0, 8)}... commit from epoch ${baseEpoch} RESOLVED: ${outcome}`
  );
}
