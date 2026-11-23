import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { KeyGroupVersion } from '$lib/services/ChannelService';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { scopeKey, scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import { isGraineReady, requireGraineRuntime } from './runtime';

/**
 * WHICH KEY-GROUP VERSION THIS DEVICE'S LAST CONVERGED ROSTER PASS STARTED FROM, per key group - a
 * community's or a private salon's (one {@link DistributionScope}) - and the one decision it serves:
 * may a load skip the next pass.
 *
 * BOTH SCOPES, SINCE THE 1.8.0-alpha.1 READING (Mi 9T, 2026-11-23): the community passes skipped, and
 * every resume still read `distribution-group` and `members` for each private salon this account
 * reads, concluding "agrees with its roster" every time - the versions answer named communities
 * only. A salon's pass is the same pass on a smaller roster, so it is the same record, keyed by scope.
 *
 * WHAT THE PASS IS FOR. A community's roster pass (`ensureDistributionGroupFor` +
 * `reconcileDistributionGroupRoster`) reads two answers - the key-group reference and the roster -
 * and compares them with the tree this device holds: a departed member's leaf is removed, a revoked
 * device's leaf is removed, a stale base is republished, a device the server forgot re-joins. The
 * live stream's return re-lists every community because a `channel.member.*` event sent while the
 * socket was down is lost (offline-and-weak-network, "A community joined while the socket was
 * down"), and the pass is where such a missed departure is caught. Measured on the owner's Android
 * log (1.7.1, 2026-11-19..22): 131 resumes, 2 325 of 5 050 requests spent on these two reads, every
 * one of them concluding "agrees with its roster, nobody to remove".
 *
 * THE SKIP AND WHY IT IS SAFE. The server answers, in one request per load sent when the load
 * starts, a digest of exactly the two answers the pass reads (`listKeyGroupVersions`,
 * social-service). What it saves is client round trips, not server work. A pass is skipped when:
 * 1. the digest equals the one read BEFORE this device's last pass that CONVERGED (held, live,
 *    current, base usable, tree agreeing with the roster, revocation question answered, admission
 *    ledger written) - so the pass would read the same two answers; and the digest cannot come
 *    back to an earlier value through a change that matters (the epochs only grow, a device row
 *    returns only through a commit, a membership row is a fresh id per admission - see the server
 *    method);
 * 2. this device still holds that group, still as a member, at exactly the server's active epoch,
 *    and the published base is not behind it - the facts the pass reads on THIS side, re-checked
 *    here because a reload of `mls.bin` or a forget can move them without the server noticing.
 * Same inputs on both sides, same decision: the pass would conclude "nothing to do" again.
 *
 * A PRIVATE SALON'S ROSTER CAN RETURN TO AN EARLIER VALUE - its rows are the community's membership
 * rows, and a reader taken off `allowedUsers` and put back is the same row. That reaches no decision
 * either: the active epoch is inside the digest and checked against the local tree, so an unchanged
 * version means the same tree AND the same roster - the pass's whole input - whatever happened
 * between. A Remove committed in between moved the epoch, and with it the version.
 *
 * CAPTURED BEFORE ASKING. The version recorded is the one read before the pass ran; a change landing
 * between that read and the pass's own reads makes the next version differ from the recorded one, so
 * the next load runs the pass again. The error can only cost a pass, never skip one that was owed.
 *
 * A PASS THAT DID NOT CONVERGE WITHDRAWS THE RECORD, WHOEVER RAN IT, BY CONSTRUCTION: the roster
 * lane (`rosterReconcile.ts`) and the coalesced join (`distributionGroup.ts`) both call
 * {@link forgetKeyGroupConvergence} on any scope whose pass did not converge - every caller
 * goes through one of the two. And a withdrawal is COUNTED: a load takes a {@link convergenceTicket}
 * before its pass, and {@link recordKeyGroupConvergence} refuses to record when any withdrawal
 * landed since - so a pass of another caller that failed while this load's pass ran can never be
 * overwritten by this load's record.
 *
 * SESSION MEMORY, ON PURPOSE. The first load of every process runs every pass in full: a device
 * revoked while its member stays and the tree stands still is invisible to both answers, and the
 * revocation question (`askRevokedLeaves`) is put again at the first pass of a session - exactly as
 * before this skip existed. Held per account and device, and forgotten at sign-out with the
 * revocation answers.
 */
const converged = new Map<string, string>();

/**
 * Withdrawals per scope, EVER - never cleared, not even at sign-out: a count that went back to
 * zero would let a ticket taken before it match again (see {@link forgetAllKeyGroupConvergence}).
 * One integer per account, device and scope seen.
 */
const withdrawals = new Map<string, number>();

/** Sessions ended on this page ({@link forgetAllKeyGroupConvergence}): the other half of a ticket. */
let sessionsEnded = 0;

/**
 * What a load holds while its pass runs: the session it started in and the withdrawals counted so
 * far. {@link recordKeyGroupConvergence} records only when both are still the same.
 */
export interface ConvergenceTicket {
  session: number;
  withdrawn: number;
}

/**
 * The record's key: the account, THIS DEVICE and the scope (`scopeKey`, so a salon's record never
 * meets its community's). A record vouches for one device's tree; an identity rotation (a revoked id
 * re-enrolled) is a new device with a tree of its own.
 */
function keyOf(scope: DistributionScope): string | null {
  if (!isGraineReady()) return null;
  const { userId, mlsService } = requireGraineRuntime('key-group convergence');
  return `${canonicalUserId(userId)}|${mlsService.getDeviceId()}|${scopeKey(scope)}`;
}

/**
 * Taken by a load BEFORE its pass: the session and the withdrawals so far, which
 * {@link recordKeyGroupConvergence} compares with both when the pass ends.
 */
export function convergenceTicket(scope: DistributionScope): ConvergenceTicket {
  const key = keyOf(scope);
  return { session: sessionsEnded, withdrawn: key ? (withdrawals.get(key) ?? 0) : 0 };
}

/**
 * Whether `scope`'s roster pass may be skipped on `version` (see the module doc for the two
 * conditions). Says which way it went when a record exists, so a skipped pass and a pass that ran
 * are told apart in the log; a scope with no record runs silently, as every first pass does.
 */
export async function convergedPassCanBeSkipped(
  mlsService: IMlsService,
  scope: DistributionScope,
  version: KeyGroupVersion,
  log: (message: string) => void
): Promise<boolean> {
  const key = keyOf(scope);
  if (!key) return false;
  const recorded = converged.get(key);
  if (recorded === undefined) return false;
  const label = scopeLabel(scope);
  if (recorded !== version.version) {
    log(
      `[GRAINE] ${label}: its key group or roster changed since the last converged pass - running it`
    );
    return false;
  }
  const localEpoch = holdsGroupState(mlsService, version.groupId)
    ? mlsService.getEpoch(version.groupId)
    : null;
  let member = false;
  try {
    member = localEpoch !== null && (await mlsService.isGroupActive(version.groupId));
  } catch (e) {
    log(
      `[GRAINE] ${label}: whether this device is still in its key group could not be read (${String(e)}) - running the pass`
    );
    return false;
  }
  const baseUsable = version.baseEpoch !== null && version.baseEpoch >= version.activeEpoch;
  if (!member || localEpoch !== version.activeEpoch || !baseUsable) {
    log(
      `[GRAINE] ${label}: unchanged on the server, but this device's tree is not where the last converged pass left it (held=${localEpoch !== null} member=${member} local=${localEpoch ?? 'none'} active=${version.activeEpoch} base=${version.baseEpoch ?? 'none'}) - running the pass`
    );
    return false;
  }
  log(
    `[GRAINE] ${label}: key group and roster unchanged since the last converged pass, tree at the active epoch ${version.activeEpoch} - roster pass skipped (no read owed)`
  );
  return true;
}

/**
 * Records that the pass started on `version`, under `ticket`, converged: the next load on the same
 * version skips. REFUSED when a pass withdrew the record since the ticket was taken - that pass,
 * whoever ran it, is newer evidence than this one - and said so.
 */
export function recordKeyGroupConvergence(
  scope: DistributionScope,
  version: KeyGroupVersion,
  ticket: ConvergenceTicket,
  log: (message: string) => void
): void {
  const key = keyOf(scope);
  if (!key) return;
  const label = scopeLabel(scope);
  if (ticket.session !== sessionsEnded) {
    log(
      `[GRAINE] ${label}: roster pass converged in a session that has since ended - not recorded, the new session runs its own first pass`
    );
    return;
  }
  if ((withdrawals.get(key) ?? 0) !== ticket.withdrawn) {
    log(
      `[GRAINE] ${label}: roster pass converged, but another pass that did not converge ended while it ran - not recorded, the next load runs it in full`
    );
    return;
  }
  if (converged.get(key) !== version.version) {
    log(
      `[GRAINE] ${label}: roster pass converged at epoch ${version.activeEpoch} - an unchanged version skips the next one`
    );
  }
  converged.set(key, version.version);
}

/** Drops `scope`'s record and counts the withdrawal: a pass that did not converge vouches against it. */
export function forgetKeyGroupConvergence(scope: DistributionScope): void {
  const key = keyOf(scope);
  if (!key) return;
  converged.delete(key);
  withdrawals.set(key, (withdrawals.get(key) ?? 0) + 1);
}

/**
 * Drops every record and ENDS THE SESSION: at sign-out (the next session runs its own first passes,
 * which put the revocation question again - the module doc's promise), and for a test.
 *
 * THE COUNTERS ARE KEPT AND THE SESSION IS COUNTED, because a load can straddle a sign-out: started
 * before it, its pass ends after a sign-in on the same account and device. Clearing the counters
 * would let its ticket match the new session's, so it would record into that session and skip the
 * first pass the session owes; the ended session refuses it instead.
 */
export function forgetAllKeyGroupConvergence(): void {
  converged.clear();
  sessionsEnded += 1;
}
