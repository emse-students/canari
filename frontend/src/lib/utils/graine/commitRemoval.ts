import type { ChannelService } from '$lib/services/ChannelService';
import {
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { reconcileDistributionGroupRoster } from './rosterReconcile';
import { isGraineReady, rawChannelId, requireGraineRuntime, scopeForChannel } from './runtime';

/**
 * THE ACTOR OF A REMOVAL COMMITS IT - channel-encryption section 10, completed 2026-10-27.
 *
 * WHAT WAS MISSING. A removal has two halves (durable-rules, "REVOCATION HAS TWO HALVES"): the
 * server unroutes the removed person at once, and the MLS Remove is a commit only a holder of the
 * key group can make. That commit was made by the roster pass (`reconcileDistributionGroupRoster`),
 * and the roster pass ran only when a community LISTING ran - an app load. So the device that had
 * just revoked somebody, holding the group and online by construction, committed nothing while it
 * stayed loaded, and every session minted meanwhile stayed at the epoch the removed devices hold:
 * the guarantee rested on server routing alone, for as long as nobody reloaded.
 *
 * THE ADMISSION'S SHAPE, MIRRORED. Whoever admits a newcomer Welcomes them (`admitNewcomer.ts`); whoever
 * removes somebody commits the Remove, right after the server accepted the removal. It is the same
 * roster pass, not a second implementation: the pass is a diff between the tree and the scope's
 * roster read NOW, after the server write, so it removes exactly whom the server no longer lists -
 * and it is serialised per scope with every other pass (`rosterReconcile.ts`), so the load's pass
 * and the actor's cannot both commit the same Remove. One writer: the actor's own device.
 *
 * WHAT IT DOES NOT COVER, AND SAYS SO. An actor that does not hold the group (an admin revoking a
 * private salon they are not in), a follower tab, a session whose Graine runtime is not wired: each
 * returns its kind and logs it. The removal is then committed by a holder's next roster pass - the
 * convergent diff that existed before this, unchanged - and nothing here retries.
 *
 * NEVER THROWS, and is never awaited by the gesture: the server half has already succeeded, and the
 * removal it reports must not be reported as failed because a commit could not follow it.
 */

/**
 * The device id the removal REQUEST names as the one that will commit (`?actorDevice=`), or
 * `undefined` when this device will commit nothing - no Graine runtime, or a tab that is not the
 * leader. The server echoes it in the removal broadcast, and every receiver leaves a scope's Remove
 * to this device exactly when the device holds a leaf of that scope's tree; otherwise the receivers
 * elect one (`departureCommitter.ts`). Naming it only when it WILL commit is what keeps that rule
 * from handing a Remove to a device that then stays silent.
 */
export function committingDeviceId(): string | undefined {
  if (!isGraineReady() || getTabLeadership() !== 'leader') return undefined;
  return requireGraineRuntime('committingDeviceId').mlsService.getDeviceId() || undefined;
}

/** What one actor-side removal commit did, in the terms its log line reports. */
export type RemovalCommitOutcome =
  /** A roster pass ran on a held group; `removedUserIds` is empty when it removed nobody. */
  | { kind: 'ran'; removedUserIds: string[] }
  /** No Graine session is wired on this device. */
  | { kind: 'no-runtime' }
  /** This tab is not the leader: only the leader commits (`FollowerTabCommitError`). */
  | { kind: 'not-leader' }
  /** This device holds no key group for the scope: a holder's next roster pass commits it. */
  | { kind: 'not-held' }
  /** The salon was never registered in this session, so its scope is unknown. */
  | { kind: 'unknown-scope' }
  /** The pass threw - a defect in a dependency, logged with its cause. */
  | { kind: 'failed' };

/**
 * Commits, from this device, the Remove a removal the server just accepted owes `scope`'s key
 * group - by running the scope's roster pass now. See the module comment.
 */
export async function commitRemovalNow(
  channelService: ChannelService,
  scope: DistributionScope,
  why: string,
  log: (message: string) => void
): Promise<RemovalCommitOutcome> {
  const label = scopeLabel(scope);
  log(`[GRAINE] REMOVE ${label}: ${why} - committing it from this device`);

  if (!isGraineReady()) {
    log(`[GRAINE] REMOVE ${label}: no Graine runtime - left to a holder's next roster pass`);
    return { kind: 'no-runtime' };
  }
  // KNOWN FROM LEADERSHIP, A FACT HERE, rather than learnt from a commit refused deep in the MLS
  // layer: only the leader tab commits, and `undecided` is not the leader either.
  if (getTabLeadership() !== 'leader') {
    log(
      `[GRAINE] REMOVE ${label}: this tab is not the leader tab (${getTabLeadership()}) - it commits nothing; a holder's next roster pass removes them`
    );
    return { kind: 'not-leader' };
  }
  const { mlsService } = requireGraineRuntime('commitRemovalNow');
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !holdsGroupState(mlsService, groupId)) {
    log(
      `[GRAINE] REMOVE ${label}: this device holds no key group for it - a holder's next roster pass removes them`
    );
    return { kind: 'not-held' };
  }

  try {
    const removedUserIds = await reconcileDistributionGroupRoster(channelService, scope, log);
    return { kind: 'ran', removedUserIds };
  } catch (e) {
    // The pass reports its own outcomes, so reaching here is a defect in a dependency: said, never
    // thrown into a gesture the server already accepted.
    log(
      `[GRAINE] REMOVE ${label}: the roster pass FAILED (${String(e)}) - a holder's next roster pass removes them`
    );
    return { kind: 'failed' };
  }
}

/**
 * Commits the Removes owed by kicking `kickedUserId` from the community `workspaceId`: from the
 * community's key group, and from every PRIVATE salon's key group of that community this device
 * holds - the kick strips the person from every salon's access in the same server call, so each
 * of those groups owes a Remove as much as the community's does.
 *
 * SEQUENTIAL, community first, as the admission is: the groups are independent, but one commit at
 * a time keeps the log in the order a reader expects. A salon this device does not hold is not
 * listed (it holds nothing to commit from), and its holders' next pass removes the person there.
 */
export async function commitCommunityKick(
  channelService: ChannelService,
  workspaceId: string,
  kickedUserId: string,
  log: (message: string) => void
): Promise<RemovalCommitOutcome[]> {
  const why = `${kickedUserId.slice(0, 8)} kicked from the community`;
  const community = workspaceScope(workspaceId);
  const outcomes = [await commitRemovalNow(channelService, community, why, log)];
  // Only once the community pass could run: every gate it refused on (runtime, leadership) refuses
  // the salons for the same reason, and has already said so.
  if (outcomes[0].kind !== 'ran' && outcomes[0].kind !== 'not-held') return outcomes;
  const { mlsService } = requireGraineRuntime('commitCommunityKick');
  const salons = mlsService
    .distributionScopes()
    .filter((s) => s.kind === 'channel' && s.workspaceId === workspaceId);
  log(
    `[GRAINE] REMOVE ${kickedUserId.slice(0, 8)}: ${salons.length} private salon(s) of ${workspaceId.slice(0, 8)} registered here - each committed in turn`
  );
  for (const salon of salons) {
    outcomes.push(await commitRemovalNow(channelService, salon, why, log));
  }
  return outcomes;
}

/**
 * Commits the Remove owed by revoking `revokedUserId`'s access to the PRIVATE salon `channelId`,
 * from its settings panel. The scope is the one this session registered for the salon; a salon it
 * never loaded cannot be held here either.
 */
export async function commitSalonRevoke(
  channelService: ChannelService,
  channelId: string,
  revokedUserId: string,
  log: (message: string) => void
): Promise<RemovalCommitOutcome> {
  const scope = scopeForChannel(channelId);
  if (!scope || scope.kind !== 'channel') {
    log(
      `[GRAINE] REMOVE ${revokedUserId.slice(0, 8)} from salon ${rawChannelId(channelId).slice(0, 8)}: no private-salon scope registered in this session - left to a holder's next roster pass`
    );
    return { kind: 'unknown-scope' };
  }
  return commitRemovalNow(
    channelService,
    scope,
    `access of ${revokedUserId.slice(0, 8)} revoked`,
    log
  );
}
