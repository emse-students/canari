import {
  channelScope,
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { isGraineReady, rawChannelId, requireGraineRuntime, workspaceForChannel } from './runtime';
import { userIdOfLeaf } from './rosterReconcile';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';

/**
 * Whoever admits a newcomer Welcomes them - channel-encryption section 20, decided by the user
 * 2026-09-27 (*"L'ajouteur envoie un welcome"*).
 *
 * WHAT WAS MISSING. Section 4.4 made the newcomer add THEMSELVES to a key group by external commit,
 * which answers the share link: the newcomer is the one acting, and is online by construction. An
 * admin adding somebody from the community panel is the other way in, and nothing admitted the
 * newcomer at all: their phone took every salon push and could open none until the app was next
 * started. Measured on production: two members added at 14:35 still had no key-group row six hours
 * later. The admitter, meanwhile, was online and holding the group.
 *
 * THE DM'S SHAPE. The client that performed the add commits an MLS Add of every device the newcomer
 * has published a KeyPackage for, and Welcomes each - `addMember -> sendWelcome` under the add-lock,
 * as `processPendingInvitations` does. A shut Android phone installs the Welcome in the background
 * (`processReceivedWelcomeBackground`) and calls `membership-active`. The Add is a commit, commits
 * rotate every sender's Graine session, and section 19 carries the new seed on the next message, so
 * the first message after the admission is readable on the lock screen.
 *
 * NOT A SECOND PATH. The self-join stays the door when the newcomer acts; this is the door when
 * someone else adds them. Nothing here retries through the other door, and a newcomer this cannot
 * admit - no KeyPackage, a group this device does not hold - keeps their own load as their door.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md` section 20.
 */

/** One device the newcomer published a KeyPackage for. */
export interface NewcomerDevice {
  deviceId: string;
  keyPackage: Uint8Array;
}

/**
 * What one admission decided, in the terms its log line reports.
 *
 * A TYPE RATHER THAN A BOOLEAN because six of the seven outcomes are "nobody was admitted" for six
 * different reasons, and a rig row asserting the admission has to be able to tell them apart.
 */
export type NewcomerAdmission =
  | { kind: 'admitted'; groupId: string; deviceIds: string[]; epoch: number }
  | { kind: 'no-runtime' }
  | { kind: 'not-held' }
  | { kind: 'no-key-package' }
  | { kind: 'already-in-tree' }
  | { kind: 'lock-busy' }
  | { kind: 'failed'; stage: 'devices' | 'lock' | 'tree' | 'commit' };

/**
 * Which of the newcomer's devices the tree does not hold yet.
 *
 * PURE, so the admit decision is asserted without an MLS group. A device whose `userId:deviceId`
 * leaf already stands was admitted already - by its own external commit, or by another admitter -
 * and adding it again is the duplicate leaf. Compared case-insensitively, like the roster diff:
 * one side is stored, the other minted.
 */
export function devicesToAdmit(input: {
  leafIdentities: string[];
  newcomerUserId: string;
  devices: NewcomerDevice[];
}): NewcomerDevice[] {
  const newcomer = input.newcomerUserId.toLowerCase();
  const leaves = new Set(
    input.leafIdentities
      .filter((identity) => userIdOfLeaf(identity) === newcomer)
      .map((identity) => identity.toLowerCase())
  );
  return input.devices.filter((d) => !leaves.has(`${newcomer}:${d.deviceId.toLowerCase()}`));
}

/**
 * Adds `newcomerUserId`'s devices to `scope`'s key-distribution group and Welcomes each of them.
 *
 * ONLY A HOLDER MAY COMMIT, so a device that does not hold the group admits nobody and says so -
 * an admin granting a private salon they are not in is the ordinary case.
 *
 * TWO ADMITTERS, AND AN ADMITTER AGAINST THE NEWCOMER'S OWN JOIN, CANNOT BOTH LAND:
 *
 * - two admitters (two admins, two devices of one admin) are serialised by the group's add-lock,
 *   taken BEFORE the tree is read, so the second reads a tree that already holds the newcomer;
 * - the newcomer's own external commit takes no lock, and needs none: both it and this Add are
 *   commits on the epoch they were built against, and `validateCommit` (chat-delivery) advances a
 *   group's epoch for exactly ONE commit per epoch, under its commit lock, refusing any other with
 *   `epoch_mismatch` - which rolls the loser back without merging (no fork). If the newcomer lands
 *   first, this Add is refused and there is nothing left to do; if this lands first, the newcomer's
 *   external commit is refused and the Welcome installs the group;
 * - the one ordering the epoch gate does not decide is a newcomer who reads the NEW base after this
 *   commit and joins on top of it. That base cannot exist before their `pending` seat does: the
 *   commit carries the devices it adds (`admits`, written in the SAME transaction as the epoch
 *   advance), and the base is minted only after it by `refreshGroupInfo`. From then until the
 *   lock is released below - after every Welcome - `ensureDistributionGroupFor` reads that seat
 *   with `addInFlight` (`readWelcomeOwedFromRow`) and waits for the Welcome instead of joining.
 *
 * NEVER THROWS: it runs after an invitation the server has already accepted, and a failure here
 * must not report the invitation as failed. Every outcome is logged and returned.
 */
export async function admitNewcomerToDistributionGroup(
  scope: DistributionScope,
  newcomerUserId: string,
  log: (message: string) => void
): Promise<NewcomerAdmission> {
  const newcomer = newcomerUserId.trim().toLowerCase();
  const label = scopeLabel(scope);
  log(`[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: start`);

  if (!isGraineReady()) {
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: no Graine runtime - nobody admitted`
    );
    return { kind: 'no-runtime' };
  }
  const { mlsService, userId, deviceKeyB64 } = requireGraineRuntime(
    'admitNewcomerToDistributionGroup'
  );

  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId || !holdsGroupState(mlsService, groupId)) {
    // Only a member may commit. Not an error: the newcomer's own load is their door, as it was.
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: this device holds no key group for it - nobody admitted, the newcomer's own load joins it`
    );
    return { kind: 'not-held' };
  }

  let devices: NewcomerDevice[];
  try {
    devices = await mlsService.fetchUserDevices(newcomer);
  } catch (e) {
    // An unreachable key service is not "no device": the two must not reach the log alike.
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: FAILED - their devices could not be read (${String(e)}) - nobody admitted`
    );
    return { kind: 'failed', stage: 'devices' };
  }
  if (devices.length === 0) {
    // AT A LEVEL THAT SAYS SO. social-service refuses an invitation to a user with no MLS device
    // at all, so an empty answer here means every KeyPackage lapsed or was consumed in between.
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: REFUSED - the newcomer has published NO KeyPackage, so no device can be Welcomed; their own load remains their door`
    );
    return { kind: 'no-key-package' };
  }

  let locked: boolean;
  try {
    locked = await mlsService.acquireAddLock(groupId);
  } catch (e) {
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: FAILED - the add-lock could not be asked for (${String(e)}) - nobody admitted`
    );
    return { kind: 'failed', stage: 'lock' };
  }
  if (!locked) {
    // Another admitter is adding into this group right now. Its Add reads the tree after ours
    // would have, so if the newcomer is its subject it admits them; if not, their own load does.
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: the group's add-lock is held by another device - nobody admitted by this one`
    );
    return { kind: 'lock-busy' };
  }

  try {
    // A REFUSED ADD IS RE-BUILT ON THE EPOCH THAT BEAT IT, and only then. The newcomer's LIVE devices
    // may join by their own external commits in the same second - they are acting, so that door is
    // theirs - and win the epoch gate. The Add is then refused and rolled back, but a DEAD device of
    // theirs has no door but this one: giving up left it out for good (NOTIF-21, 2026-09-28). So the
    // tree is read again, after the refusal's catch-up applied the winning commit, and only the
    // devices still without a leaf are added. TERMINATION IS A PROOF, NOT A COUNT: a retry is taken
    // only when the local epoch MOVED past the one the refused Add was built on, i.e. one foreign
    // commit was consumed; a catch-up that could not move it ends the admission, loudly.
    let missing: NewcomerDevice[];
    let result: Awaited<ReturnType<typeof mlsService.addMembersBulk>>;
    for (;;) {
      let leafIdentities: string[];
      try {
        // AFTER the lock, so a concurrent admitter's merged Add is in the tree this reads.
        leafIdentities = await mlsService.getGroupMemberIdentities(groupId);
      } catch (e) {
        log(
          `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: FAILED - the tree could not be read (${String(e)}) - nobody admitted`
        );
        return { kind: 'failed', stage: 'tree' };
      }

      missing = devicesToAdmit({ leafIdentities, newcomerUserId: newcomer, devices });
      if (missing.length === 0) {
        log(
          `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: all ${devices.length} device(s) already hold a leaf - no commit`
        );
        return { kind: 'already-in-tree' };
      }

      const builtOn = mlsService.getEpoch(groupId);
      try {
        // ONE commit for every missing device, so an admission costs one epoch whatever the fleet.
        // The newcomer's devices are excluded from the commit's fan-out: the Welcome is what they
        // get, and a commit for an epoch they are not in yet is a frame they can never open.
        result = await mlsService.addMembersBulk(
          groupId,
          missing.map((d) => ({ deviceId: d.deviceId, keyPackage: d.keyPackage })),
          missing.map((d) => `${newcomer}:${d.deviceId}`)
        );
        break;
      } catch (e) {
        const caughtUpTo = mlsService.getEpoch(groupId);
        if (e instanceof CommitRefusedError && caughtUpTo > builtOn) {
          log(
            `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: the Add built on epoch ${builtOn} lost to a commit (${e.reason}); caught up to ${caughtUpTo} - re-reading the tree`
          );
          continue;
        }
        // Every other outcome ends here, with nobody admitted by THIS device - and a dead device of
        // the newcomer's with no door at all, which is why this is a warning and not narration.
        console.warn(
          `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: the Add was not accepted and could not be rebuilt (${String(e)}; epoch ${builtOn} -> ${caughtUpTo}) - ${missing.length} device(s) of theirs NOT admitted`
        );
        return { kind: 'failed', stage: 'commit' };
      }
    }

    if (result.skippedDeviceIds.length > 0) {
      log(
        `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: ${result.skippedDeviceIds.length} device(s) skipped - their KeyPackage could not be used: ${result.skippedDeviceIds.join(',')}`
      );
    }

    // THE EPOCH MOVED, SO THE DISK MOVES WITH IT, before anything else can fail: an Add merged only
    // in memory is one the next load walks back out of, leaving Welcomes for a tree nobody holds.
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

    const welcomed: string[] = [];
    if (!result.welcome) {
      log(
        `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: the Add merged but produced NO Welcome - ${result.addedDeviceIds.length} leaf/leaves nobody can open`
      );
    } else {
      // ONE Welcome per device, each in its own try: one device the server cannot route to must not
      // cost the others their admission.
      for (const deviceId of result.addedDeviceIds) {
        try {
          await mlsService.sendWelcome(
            result.welcome,
            newcomer,
            groupId,
            deviceId,
            result.ratchetTree
          );
          welcomed.push(deviceId);
          log(`[GRAINE] ADMIT Welcome -> ${newcomer.slice(0, 8)}:${deviceId} for ${label}`);
        } catch (e) {
          log(
            `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: the Welcome to ${deviceId} was NOT delivered (${String(e)}) - that device holds a leaf it cannot open until it rejoins`
          );
        }
      }
    }

    const epoch = mlsService.getEpoch(groupId);
    log(
      `[GRAINE] ADMIT ${newcomer.slice(0, 8)} into ${label}: admitted ${welcomed.length}/${missing.length} device(s), group now at epoch ${epoch} - the next send rotates its session`
    );
    return { kind: 'admitted', groupId, deviceIds: welcomed, epoch };
  } finally {
    await mlsService
      .releaseAddLock(groupId)
      .catch((e: unknown) =>
        log(`[GRAINE] ADMIT ${label}: the add-lock could not be released (${String(e)})`)
      );
  }
}

/**
 * Admits a member just added to a community through `inviteToChannel`: into the community's key
 * group, and into the salon's own when the invitation was to a PRIVATE salon - the server grants
 * both in that one call (`allowedUsers` is written for a new member of a private salon).
 *
 * SEQUENTIAL, community first: the two groups are independent, but one lock and one commit at a
 * time keeps the log in the order a reader expects.
 */
export async function admitInvitedMember(
  workspaceId: string,
  channelId: string,
  isPrivateSalon: boolean,
  newcomerUserId: string,
  log: (message: string) => void
): Promise<NewcomerAdmission[]> {
  log(
    `[GRAINE] ADMIT invited ${newcomerUserId.slice(0, 8)} to ${workspaceId.slice(0, 8)} (private salon: ${isPrivateSalon})`
  );
  const scopes: DistributionScope[] = [workspaceScope(workspaceId)];
  if (isPrivateSalon) scopes.push(channelScope(workspaceId, channelId));
  const outcomes: NewcomerAdmission[] = [];
  for (const scope of scopes) {
    outcomes.push(await admitNewcomerToDistributionGroup(scope, newcomerUserId, log));
  }
  return outcomes;
}

/**
 * Admits a community member just granted a PRIVATE salon from its settings panel into that salon's
 * own key group. The grantee is already in the community's group (or their own load puts them
 * there), so only the salon's is owed.
 *
 * The community is resolved from the channel map the session loaded; a salon whose community this
 * session never loaded cannot be held here either, and says so.
 */
export async function admitSalonGrantee(
  channelId: string,
  granteeUserId: string,
  log: (message: string) => void
): Promise<NewcomerAdmission> {
  const channel = rawChannelId(channelId);
  const workspaceId = workspaceForChannel(channel);
  log(
    `[GRAINE] ADMIT salon grantee ${granteeUserId.slice(0, 8)} to ${channel.slice(0, 8)} (community ${workspaceId?.slice(0, 8) ?? 'unknown'})`
  );
  if (!workspaceId) {
    log(
      `[GRAINE] ADMIT ${granteeUserId.slice(0, 8)} into salon ${channel.slice(0, 8)}: its community is not loaded here - nobody admitted, the grantee's own load joins it`
    );
    return { kind: 'not-held' };
  }
  return admitNewcomerToDistributionGroup(channelScope(workspaceId, channel), granteeUserId, log);
}
