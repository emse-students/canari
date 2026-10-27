import type { ChannelMemberDto, ChannelService } from '$lib/services/ChannelService';
import {
  channelScope,
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import {
  canonicalIdentity,
  canonicalUserId,
  deviceIdOfLeaf,
  userIdOfLeaf,
} from '$lib/mls-client/leafIdentity';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { reconcileDistributionGroupRoster } from './rosterReconcile';
import { isGraineReady, rawChannelId, requireGraineRuntime } from './runtime';

/**
 * WHO COMMITS A DEPARTURE THE ACTOR CANNOT - decided 2026-10-27 (channel-encryption section 10).
 *
 * A member's own LEAVE has nobody to commit it: MLS does not let a member commit its own removal,
 * and the leaver's devices are unrouted before anything could reach them. The same holds for a
 * kick or a revoke whose actor holds no leaf in a scope's tree - an admin removing somebody from a
 * private salon they are not in. Until now the Remove waited for some member's next app load.
 *
 * THE DECISION: ONE remaining device, ELECTED THE SAME WAY BY EVERY RECEIVER of the removal
 * broadcast, commits it - the first, in canonical `userId:deviceId` order, of the leaves of the
 * scope's tree whose user is on the scope's roster (the departed user excluded) and whose DEVICE the
 * roster read reports online. Every receiver reads the same tree (one epoch) and the same roster, so
 * they name the same device; the elected device runs the scope's roster pass, and the others commit
 * nothing and say whom they left it to.
 *
 * WHY NOT EVERY RECEIVER. Each would build the same Remove on the same epoch; the server accepts one
 * and refuses the rest, and every refusal is a rolled-back commit and a misleading line. One writer
 * per commit.
 *
 * WHY PRESENCE, AND NOT A CLOCK. An elected device that is offline commits nothing, so the
 * election is restricted to devices the server reports online - the fact the history repair already
 * elects by (`repair.ts`). Two receivers reading presence a moment apart may disagree: two elected
 * means the epoch gate keeps one commit and the second pass finds nothing to remove; none elected
 * means the Remove waits for a holder's next roster pass, which is the convergent diff this always
 * had. Neither is retried here, and no timer stands in for the election.
 *
 * WHEN THE ACTOR HOLDS A LEAF, THE ACTOR COMMITS (`commitRemoval.ts`), and the receivers do nothing:
 * the device that performed the removal ran the pass at the time.
 */

/** A roster row as the election reads it: who, and which of their devices are online. */
export type PresenceRow = Pick<ChannelMemberDto, 'userId' | 'onlineDevices'>;

/**
 * The leaf identity elected to commit `departedUserId`'s removal, or null when no device can be
 * elected (no online leaf, or a roster that carries no per-device presence). PURE.
 */
export function electDepartureCommitter(input: {
  leafIdentities: string[];
  rosterRows: PresenceRow[];
  departedUserId: string;
}): string | null {
  const departed = canonicalUserId(input.departedUserId);
  const online = new Map<string, Set<string>>();
  for (const row of input.rosterRows) {
    // A roster without per-device presence is not "everybody offline": it cannot elect at all.
    if (!Array.isArray(row.onlineDevices)) return null;
    online.set(canonicalUserId(String(row.userId)), new Set(row.onlineDevices));
  }
  const candidates = input.leafIdentities
    .map((identity) => ({
      user: userIdOfLeaf(identity),
      device: deviceIdOfLeaf(identity),
      key: canonicalIdentity(identity),
    }))
    .filter(
      (c): c is { user: string; device: string; key: string } =>
        c.key !== null && c.user !== departed && online.get(c.user)?.has(c.device) === true
    )
    .map((c) => c.key)
    .sort();
  return candidates[0] ?? null;
}

/** What one receiver decided about one scope, in the terms its log line reports. */
export type DepartureDecision =
  | 'actor-commits'
  | 'elected-here'
  | 'elected-elsewhere'
  | 'nobody-elected'
  | 'not-held'
  | 'not-leader'
  | 'no-runtime'
  | 'unreadable';

/**
 * Handles a removal broadcast about SOMEBODY ELSE, for every key group it touches that this device
 * holds: the community's and its private salons' for a community departure, the salon's own for a
 * salon departure. Never throws; every outcome is logged and returned per scope.
 */
export async function commitDepartureIfElected(
  channelService: ChannelService,
  event: {
    workspaceId: string;
    /** Empty for a community-wide departure. */
    channelId: string;
    channelIsPrivate: boolean;
    departedUserId: string;
    /** Who performed it; the departed user themselves for a leave. */
    actorUserId?: string | null;
  },
  log: (message: string) => void
): Promise<DepartureDecision[]> {
  if (!isGraineReady()) {
    log("[GRAINE] DEPARTURE: no Graine runtime - left to a holder's next roster pass");
    return ['no-runtime'];
  }
  const { mlsService } = requireGraineRuntime('commitDepartureIfElected');
  let scopes: DistributionScope[];
  if (!event.channelId) {
    scopes = [
      workspaceScope(event.workspaceId),
      ...mlsService
        .distributionScopes()
        .filter((s) => s.kind === 'channel' && s.workspaceId === event.workspaceId),
    ];
  } else if (event.channelIsPrivate) {
    scopes = [channelScope(event.workspaceId, rawChannelId(event.channelId))];
  } else {
    // A public salon has no key group of its own: its readers are the community's.
    return [];
  }
  const decisions: DepartureDecision[] = [];
  for (const scope of scopes) {
    decisions.push(await decideForScope(channelService, scope, event, log));
  }
  return decisions;
}

async function decideForScope(
  channelService: ChannelService,
  scope: DistributionScope,
  event: { departedUserId: string; actorUserId?: string | null },
  log: (message: string) => void
): Promise<DepartureDecision> {
  const label = scopeLabel(scope);
  const departed = event.departedUserId.slice(0, 8);
  const { mlsService, userId } = requireGraineRuntime('decide a departure commit');
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !holdsGroupState(mlsService, groupId)) {
    // Silent would be indistinguishable from a receiver that never ran; this is a debug line.
    log(`[GRAINE] DEPARTURE ${departed} from ${label}: no key group held here - nothing to decide`);
    return 'not-held';
  }
  try {
    const leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
    const actor = event.actorUserId ? canonicalUserId(event.actorUserId) : null;
    if (
      actor &&
      actor !== canonicalUserId(event.departedUserId) &&
      leafIdentities.some((identity) => userIdOfLeaf(identity) === actor)
    ) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: the actor ${actor.slice(0, 8)} holds a leaf - the actor's device commits it`
      );
      return 'actor-commits';
    }
    const rosterRows: PresenceRow[] =
      scope.kind === 'workspace'
        ? await channelService.listWorkspaceMembers(scope.workspaceId, { presence: true })
        : await channelService.listMembers(scope.channelId, 'channel', { presence: true });
    const elected = electDepartureCommitter({
      leafIdentities,
      rosterRows,
      departedUserId: event.departedUserId,
    });
    if (!elected) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: no online device of a remaining member could be elected - a holder's next roster pass removes them`
      );
      return 'nobody-elected';
    }
    const self = canonicalIdentity(`${userId}:${mlsService.getDeviceId()}`);
    if (elected !== self) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: ${elected.slice(0, 20)} is elected to commit it - not this device`
      );
      return 'elected-elsewhere';
    }
    // Leadership is a fact here: the tab holding the socket is the leader, and only it commits.
    if (getTabLeadership() !== 'leader') {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: this device is elected but this tab is not the leader - a holder's next roster pass removes them`
      );
      return 'not-leader';
    }
    log(`[GRAINE] DEPARTURE ${departed} from ${label}: this device is elected - committing it`);
    await reconcileDistributionGroupRoster(channelService, scope, log);
    return 'elected-here';
  } catch (e) {
    log(
      `[GRAINE] DEPARTURE ${departed} from ${label}: the tree or the roster could not be read (${String(e)}) - nobody committed it from here`
    );
    return 'unreadable';
  }
}
