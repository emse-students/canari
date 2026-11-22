import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { KeyGroupVersion } from '$lib/services/ChannelService';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { isGraineReady, requireGraineRuntime } from './runtime';

/**
 * WHICH KEY-GROUP VERSION THIS DEVICE'S LAST CONVERGED ROSTER PASS STARTED FROM, per community - and
 * the one decision it serves: may a load skip the next pass.
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
 * THE SKIP AND WHY IT IS SAFE. The server answers, in one request per load, a digest of exactly the
 * two answers the pass reads (`listKeyGroupVersions`, social-service). A pass is skipped when:
 * 1. the digest equals the one read BEFORE this device's last pass that CONVERGED (held, live,
 *    current, base usable, tree agreeing with the roster, revocation question answered) - so the
 *    pass would read the same two answers; and the digest cannot come back to an earlier value
 *    through a change that matters (the epochs only grow, a device row returns only through a
 *    commit, a membership row is a fresh id per admission - see the server method);
 * 2. this device still holds that group, still as a member, at exactly the server's active epoch,
 *    and the published base is not behind it - the facts the pass reads on THIS side, re-checked
 *    here because a reload of `mls.bin` or a forget can move them without the server noticing.
 * Same inputs on both sides, same decision: the pass would conclude "nothing to do" again.
 *
 * CAPTURED BEFORE ASKING. The version recorded is the one read before the pass ran; a change landing
 * between that read and the pass's own reads makes the next version differ from the recorded one, so
 * the next load runs the pass again. The error can only cost a pass, never skip one that was owed.
 *
 * SESSION MEMORY, ON PURPOSE. The first load of every process runs every pass in full: a device
 * revoked while its member stays and the tree stands still is invisible to both answers, and the
 * revocation question (`askRevokedLeaves`) is put again at the first pass of a session - exactly as
 * before this skip existed. Held per account, and forgotten at sign-out with the revocation answers.
 */
const converged = new Map<string, string>();

function keyOf(workspaceId: string): string | null {
  if (!isGraineReady()) return null;
  const { userId } = requireGraineRuntime('key-group convergence');
  return `${canonicalUserId(userId)}|${workspaceId}`;
}

/**
 * Whether `workspaceId`'s roster pass may be skipped on `version` (see the module doc for the two
 * conditions). Says which way it went when a record exists, so a skipped pass and a pass that ran
 * are told apart in the log; a community with no record runs silently, as every first pass does.
 */
export async function convergedPassCanBeSkipped(
  mlsService: IMlsService,
  workspaceId: string,
  version: KeyGroupVersion,
  log: (message: string) => void
): Promise<boolean> {
  const key = keyOf(workspaceId);
  if (!key) return false;
  const recorded = converged.get(key);
  if (recorded === undefined) return false;
  const short = workspaceId.slice(0, 8);
  if (recorded !== version.version) {
    log(
      `[GRAINE] community ${short}: its key group or roster changed since the last converged pass - running it`
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
      `[GRAINE] community ${short}: whether this device is still in its key group could not be read (${String(e)}) - running the pass`
    );
    return false;
  }
  const baseUsable = version.baseEpoch !== null && version.baseEpoch >= version.activeEpoch;
  if (!member || localEpoch !== version.activeEpoch || !baseUsable) {
    log(
      `[GRAINE] community ${short}: unchanged on the server, but this device's tree is not where the last converged pass left it (held=${localEpoch !== null} member=${member} local=${localEpoch ?? 'none'} active=${version.activeEpoch} base=${version.baseEpoch ?? 'none'}) - running the pass`
    );
    return false;
  }
  log(
    `[GRAINE] community ${short}: key group and roster unchanged since the last converged pass, tree at the active epoch ${version.activeEpoch} - roster pass skipped (no read owed)`
  );
  return true;
}

/** Records that the pass started on `version` converged: the next load on the same version skips. */
export function recordKeyGroupConvergence(
  workspaceId: string,
  version: KeyGroupVersion,
  log: (message: string) => void
): void {
  const key = keyOf(workspaceId);
  if (!key) return;
  if (converged.get(key) !== version.version) {
    log(
      `[GRAINE] community ${workspaceId.slice(0, 8)}: roster pass converged at epoch ${version.activeEpoch} - an unchanged version skips the next one`
    );
  }
  converged.set(key, version.version);
}

/** Drops `workspaceId`'s record: a pass that did not converge vouches against it. */
export function forgetKeyGroupConvergence(workspaceId: string): void {
  const key = keyOf(workspaceId);
  if (key) converged.delete(key);
}

/** Drops every record: at sign-out (the next account runs its own passes), and for a test. */
export function forgetAllKeyGroupConvergence(): void {
  converged.clear();
}
