import type { ChannelMemberDto, ChannelService } from '$lib/services/ChannelService';
import {
  channelScope,
  scopeKey,
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
import { isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { reconcileDistributionGroupRoster } from './rosterReconcile';
import { isGraineReady, rawChannelId, requireGraineRuntime } from './runtime';

/**
 * WHO COMMITS A DEPARTURE THE ACTOR CANNOT - decided 2026-10-27 (channel-encryption section 10).
 *
 * A member's own LEAVE has nobody to commit it: MLS does not let a member commit its own removal,
 * and the leaver's devices are unrouted before anything could reach them. The same holds for a
 * kick or a revoke whose actor's DEVICE holds no leaf in a scope's tree - an admin removing somebody
 * from a private salon they are not in, or an actor on a tab that commits nothing. Until now the
 * Remove waited for some member's next app load.
 *
 * THE ACTOR, BY DEVICE. A removal request names the actor's device when that device will commit
 * (`committingDeviceId`, echoed by the server as `actorDeviceId`). A receiver leaves a scope's
 * Remove to the actor exactly when that DEVICE is a leaf of the scope's tree; a user-level check
 * would hand it to an actor whose other device holds the leaf while the acting one holds nothing.
 *
 * A CLAIM IS NOT A COMMIT. The actor's commit may stage nothing, fail, or never be sent (the app
 * closed). So a receiver that left a scope to the actor REMEMBERS it ({@link departuresLeftToActors})
 * and decides it again, without the claim, on the next signal it observes - a reconnect, the app
 * coming to the foreground, or the next removal broadcast it handles
 * ({@link revisitDeparturesLeftToActors}). If the departed user still holds a leaf then, the
 * election runs; if not, the actor's commit landed and the entry is dropped. No timer: the worst
 * case is the next signal, and without one the next app load's roster pass.
 *
 * THE ELECTION. Otherwise ONE remaining device, ELECTED THE SAME WAY BY EVERY RECEIVER, commits it:
 * the first device the roster reports online, in a window of {@link ELECTION_WINDOW} leaves of the
 * tree (the departed user's excluded) whose user is on the scope's roster. Every receiver reads the
 * same tree at the same epoch, so they agree on the window without asking anything - and only a
 * receiver whose own leaf IS in the window reads the roster with presence: a departure in a
 * community of hundreds costs at most that many roster reads, not one per member.
 *
 * THE WINDOW MOVES. A fixed window - the first leaves in sort order - would starve every election
 * on the same prefix of leaves that cannot commit: a stale device, a revoked leaf not yet removed, a
 * stray, an older client. So the window starts at an offset derived from the departure itself
 * ({@link windowOffset}: a hash of the departed user and the epoch), the same for every receiver
 * and different for the next departure or the next epoch. A window that elects nobody says so from
 * each of its members (`nobody-elected`), so a starvation is visible, not silent.
 *
 * WHY NOT EVERY RECEIVER. Each would build the same Remove on the same epoch; the server accepts one
 * and refuses the rest, and every refusal is a rolled-back commit and a misleading line. One writer.
 *
 * WHY PRESENCE, AND NOT A CLOCK. An elected device that is offline commits nothing, so the election
 * is restricted to devices the server reports online - the fact the history repair already elects
 * by (`repair.ts`). Two receivers reading presence a moment apart may disagree: two elected means the
 * epoch gate keeps one commit and the second pass reads the tree again and says "already gone"; none
 * elected means the Remove waits for a holder's next roster pass, the convergent diff this always
 * had. Neither is retried, and no timer stands in for the election.
 *
 * THE LIMIT IT NAMES RATHER THAN HIDES. Presence says a device is ONLINE, not that it CAN commit: an
 * elected device that does not hold the group, sits in an epoch gap, runs on a follower tab, or is
 * an older client that predates this election commits nothing - the first three say so in their
 * own log, the last cannot. No capability travels with presence today, so each of those cases is
 * left to the backstop: a holder's next roster pass, at worst the next app load. A member who keeps
 * a modified client online can delay a Remove the same way, never cause a wrong one - the elected
 * device runs the roster DIFF, which the event payload does not steer.
 */

/** How many leaves of the tree may be elected - and read the roster to find out. */
export const ELECTION_WINDOW = 4;

/** A roster row as the election reads it: who, and which of their devices are online. */
export type PresenceRow = Pick<ChannelMemberDto, 'userId' | 'onlineDevices'>;

/**
 * Where a departure's election window starts in the sorted leaves: FNV-1a of the departed user and
 * the epoch, so every receiver at that epoch agrees, and the next departure or epoch moves it. PURE.
 */
export function windowOffset(departedUserId: string, epoch: number, leafCount: number): number {
  if (leafCount <= 0) return 0;
  let hash = 0x811c9dc5;
  for (const char of `${canonicalUserId(departedUserId)}|${epoch}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % leafCount;
}

/**
 * The canonical identities that may be elected for `departedUserId`'s removal at `epoch`, in
 * election order: {@link ELECTION_WINDOW} leaves of the sorted tree (the departed user's excluded),
 * starting at {@link windowOffset} and wrapping around. PURE, and a function of the tree and its
 * epoch alone, so every receiver computes the same window without a request.
 */
export function electionWindow(
  leafIdentities: string[],
  departedUserId: string,
  epoch: number
): string[] {
  const departed = canonicalUserId(departedUserId);
  const sorted = [
    ...new Set(
      leafIdentities
        .map((identity) => canonicalIdentity(identity))
        .filter((key): key is string => key !== null && userIdOfLeaf(key) !== departed)
    ),
  ].sort();
  const start = windowOffset(departedUserId, epoch, sorted.length);
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, ELECTION_WINDOW);
}

/**
 * The leaf identity elected to commit `departedUserId`'s removal, or null when no device can be
 * elected (no online leaf in the window, or a roster that carries no per-device presence). PURE.
 */
export function electDepartureCommitter(input: {
  leafIdentities: string[];
  rosterRows: PresenceRow[];
  departedUserId: string;
  epoch: number;
}): string | null {
  const online = new Map<string, Set<string>>();
  for (const row of input.rosterRows) {
    // A roster without per-device presence is not "everybody offline": it cannot elect at all.
    if (!Array.isArray(row.onlineDevices)) return null;
    online.set(canonicalUserId(String(row.userId)), new Set(row.onlineDevices));
  }
  return (
    electionWindow(input.leafIdentities, input.departedUserId, input.epoch).find(
      (key) => online.get(userIdOfLeaf(key))?.has(deviceIdOfLeaf(key)) === true
    ) ?? null
  );
}

/** What one receiver decided about one scope, in the terms its log line reports. */
export type DepartureDecision =
  | 'actor-commits'
  | 'not-in-tree'
  | 'outside-window'
  | 'elected-here'
  | 'elected-elsewhere'
  | 'nobody-elected'
  | 'cannot-commit'
  | 'not-held'
  | 'not-leader'
  | 'no-runtime'
  | 'unreadable';

/** A departure as one receiver decides it. */
interface DepartureFacts {
  departedUserId: string;
  /** Who performed it; the departed user themselves for a leave. */
  actorUserId?: string | null;
  /** The actor's device that commits it, when the actor named one (`committingDeviceId`). */
  actorDeviceId?: string | null;
}

/**
 * The scopes this device left to an actor's claim, by `scopeKey|departed user`, until a later signal
 * shows the actor's commit landed (the departed user holds no leaf) or decides them again without
 * the claim. Session memory: losing it on a reload loses nothing - the load's roster pass is the
 * backstop it stands in front of.
 */
const departuresLeftToActors = new Map<
  string,
  { scope: DistributionScope; departedUserId: string }
>();

/**
 * Handles a removal broadcast about SOMEBODY ELSE, for every key group it touches that this device
 * holds: the community's and its private salons' for a community departure, the salon's own for a
 * salon departure. First decides again every departure left to an actor that has not landed. Never
 * throws; every outcome is logged and returned per scope.
 */
export async function commitDepartureIfElected(
  channelService: ChannelService,
  event: DepartureFacts & {
    workspaceId: string;
    /** Empty for a community-wide departure. */
    channelId: string;
    channelIsPrivate: boolean;
  },
  log: (message: string) => void
): Promise<DepartureDecision[]> {
  if (!isGraineReady()) {
    log("[GRAINE] DEPARTURE: no Graine runtime - left to a holder's next roster pass");
    return ['no-runtime'];
  }
  await revisitDeparturesLeftToActors(channelService, log);
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

/**
 * Decides AGAIN, without the actor's claim, every departure this device left to an actor: called on
 * a reconnect and a return to the foreground, and before each removal broadcast is handled. A
 * departure whose user no longer holds a leaf landed and is dropped; one still in the tree goes to
 * the election. Never throws. Cheap when nothing is owed: an empty map is the ordinary case.
 */
export async function revisitDeparturesLeftToActors(
  channelService: ChannelService,
  log: (message: string) => void
): Promise<void> {
  if (departuresLeftToActors.size === 0 || !isGraineReady()) return;
  const owed = [...departuresLeftToActors.entries()];
  departuresLeftToActors.clear();
  log(`[GRAINE] DEPARTURE: ${owed.length} removal(s) left to an actor decided again`);
  for (const [, { scope, departedUserId }] of owed) {
    await decideForScope(channelService, scope, { departedUserId }, log);
  }
}

/** Forgets every departure left to an actor - a sign-out. */
export function forgetDeparturesLeftToActors(): void {
  departuresLeftToActors.clear();
}

async function decideForScope(
  channelService: ChannelService,
  scope: DistributionScope,
  event: DepartureFacts,
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
    const departedUser = canonicalUserId(event.departedUserId);
    if (!leafIdentities.some((identity) => userIdOfLeaf(identity) === departedUser)) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: they hold no leaf here - nothing to remove`
      );
      return 'not-in-tree';
    }
    const actorLeaf =
      event.actorUserId && event.actorDeviceId
        ? canonicalIdentity(`${event.actorUserId}:${event.actorDeviceId}`)
        : null;
    if (actorLeaf && leafIdentities.some((identity) => canonicalIdentity(identity) === actorLeaf)) {
      departuresLeftToActors.set(`${scopeKey(scope)}|${departedUser}`, {
        scope,
        departedUserId: event.departedUserId,
      });
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: the actor's device ${actorLeaf.slice(0, 8)} holds a leaf - left to it, decided again on the next reconnect or removal`
      );
      return 'actor-commits';
    }
    const self = canonicalIdentity(`${userId}:${mlsService.getDeviceId()}`);
    const epoch = mlsService.getEpoch(groupId);
    const window = electionWindow(leafIdentities, event.departedUserId, epoch);
    if (!self || !window.includes(self)) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: this device is not among the ${ELECTION_WINDOW} leaves that may be elected at epoch ${epoch} - left to them`
      );
      return 'outside-window';
    }
    const rosterRows: PresenceRow[] =
      scope.kind === 'workspace'
        ? await channelService.listWorkspaceMembers(scope.workspaceId, { presence: true })
        : await channelService.listMembers(scope.channelId, 'channel', { presence: true });
    const elected = electDepartureCommitter({
      leafIdentities,
      rosterRows,
      departedUserId: event.departedUserId,
      epoch,
    });
    if (!elected) {
      // Said by EVERY member of the window, so a window that starves is visible in each of them.
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: nobody elected - no device of the ${window.length} leaves that may be elected at epoch ${epoch} is online; a holder's next roster pass removes them`
      );
      return 'nobody-elected';
    }
    if (elected !== self) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: ${elected.slice(0, 8)} is elected to commit it - not this device`
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
    // A group in an epoch gap is out of every send and every commit until the ladder repairs it.
    if (isInEpochGap(groupId)) {
      log(
        `[GRAINE] DEPARTURE ${departed} from ${label}: this device is elected but its group is in an epoch gap - it cannot commit; a holder's next roster pass removes them`
      );
      return 'cannot-commit';
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
