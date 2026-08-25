import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, And, LessThan, MoreThanOrEqual } from 'typeorm';
import * as crypto from 'crypto';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from '../internal/service-urls';
import { fetchUserDeviceCount } from '../internal/delivery.client';
import {
  channelScope,
  createDistributionGroup,
  deleteDistributionGroup,
  evictFromDistributionGroup,
  publishDistributionGroupInfo,
  readDistributionGroup,
  workspaceScope,
  type DistributionGroupRef,
} from './distribution-group.client';

import {
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  RETIRED_PERMISSIONS,
  writePolicyAllows,
} from './permissions';

import {
  CreateChannelDto,
  CreateRoleDto,
  CreateWorkspaceDto,
  ChannelJoinDto,
  ChannelLeaveDto,
  ChannelInviteDto,
  ChannelUpdateRoleDto,
  SendChannelMessageDto,
  type ChannelNotificationLevel,
  type ChannelPollMeta,
  type ServedChannelPollMeta,
  type ChannelWritePolicy,
  type HistoryVisibility,
  type WorkspaceInviteDto,
} from './dto/channel.dto';

/** Manages workspaces, channels, roles, members and encrypted messages. */
/**
 * How many session ids one liveness query may carry.
 *
 * A bound rather than a page: a device holding more sessions than this asks in several requests,
 * because a SILENTLY truncated answer would read as "the rest are dead" and delete live seeds.
 */
export const MAX_LIVE_SESSION_QUERY = 500;

/**
 * THE one rule for who may READ a channel, with no database in it.
 *
 *  - a public channel is readable by every community member;
 *  - a private one by the users listed in `allowedUsers`. That is the whole rule.
 *
 * It is pure because the same rule has to be evaluated two ways and must not be able to answer
 * differently: once for ONE actor on a guarded route ({@link ChannelService.canAccessChannel}) and
 * once for EVERY member when an audience is being built
 * ({@link ChannelService.channelAudience}).
 *
 * The rule had three separate implementations and the audience was not one of them: every channel
 * event was addressed to the whole community, so a private salon's ciphertext was pushed live to
 * members who could not open the channel. Sharing this function is what makes that unrepeatable -
 * `docs/wiki/protocols/channel-encryption.md` §11.
 *
 * **AN ADMIN NO LONGER READS A PRIVATE SALON THEY HAVE NOT JOINED** - the user's decision of
 * 2026-08-19, and the third argument this function used to take is gone with it. Ambient access
 * cost nothing while the seed was the community's; under a group per private salon it would make
 * every promotion to admin a commit on EVERY private salon. An admin still SEES that such a salon
 * exists and may add themselves to it in one act, which costs one commit at that moment and
 * nothing afterwards - and it means a private salon's members can finally see who reads it, which
 * ambient access made impossible.
 */
export function channelIsReadableBy(
  channel: Pick<Channel, 'isPrivate' | 'allowedUsers'>,
  userId: string
): boolean {
  if (!channel.isPrivate) return true;
  return (channel.allowedUsers || []).includes(userId.trim().toLowerCase());
}

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  /** Normalises a French or English role label to one of three canonical values: admin, moderator, or member. */
  private normalizeRoleLabelToCanonical(name?: string | null): 'admin' | 'moderator' | 'member' {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (
      normalized === 'administrateur' ||
      normalized === 'administrator' ||
      normalized === 'admin'
    ) {
      return 'admin';
    }
    if (normalized === 'moderateur' || normalized === 'moderator') {
      return 'moderator';
    }
    return 'member';
  }

  /** Maps any role name input to the canonical display name stored in the workspace roles table. */
  private mapRoleInputToWorkspaceRoleName(name?: string | null): string {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!normalized || normalized === 'member' || normalized === 'membre') return 'Membre';
    if (
      normalized === 'admin' ||
      normalized === 'administrateur' ||
      normalized === 'administrator'
    ) {
      return 'Administrateur';
    }
    if (normalized === 'moderator' || normalized === 'moderateur' || normalized === 'modérateur') {
      return 'Modérateur';
    }
    return name?.trim() || 'Membre';
  }

  /**
   * Returns true if the calling user holds a specific workspace-level permission
   * (derived from their role memberships). An admin (workspace.manage) implicitly
   * holds every permission, so this returns true for any permission an admin is checked for.
   */
  private async memberHasWorkspacePermission(
    workspaceId: string,
    userId: string,
    permission: string
  ): Promise<boolean> {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some(
      (r) =>
        r.permissions.includes(permission) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
  }

  /**
   * Whether ONE actor may read `channel`. {@link channelIsReadableBy}, and nothing else.
   *
   * It used to spend a permission query so an admin could fall through to every private salon.
   * That fallback went with the per-salon distribution group (see the rule's own header), which
   * makes this both stricter and cheaper: no database at all.
   *
   * Reading/joining is independent of who may write (see canWriteToChannel).
   */
  private canAccessChannel(channel: Channel, _member: ChannelMember, userId?: string): boolean {
    if (!channel.isPrivate) return true;
    if (!userId) return false;
    return channelIsReadableBy(channel, userId.trim().toLowerCase());
  }

  /**
   * WHO A CHANNEL EVENT MAY BE ADDRESSED TO - the accessible subset of the community, never the
   * community.
   *
   * Every event a channel emits used to go to `getWorkspaceMemberIds`, which answers a question
   * about the CONTAINER. For a private salon that handed its ciphertext, its typing, its pins and
   * its poll tallies to members the server would refuse to serve it over REST - and since the
   * Graine seed travels on the community's distribution group, those members held the key as well.
   * An audience is derived from ACCESS or it is not an access control.
   *
   * One `find` for the roles and one for the members, whatever the size of the roster, so this is
   * usable on the send path. A public channel skips the role load entirely.
   *
   * @returns the user ids that may read `channel`. Never includes a non-member.
   */
  private async channelAudience(channel: Channel): Promise<string[]> {
    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    if (!channel.isPrivate) return members.map((m) => m.userId);
    // ONE query now, not two: the role load existed only to find the admins who read every private
    // salon ambiently, and there are none. `allowedUsers` is the roster, and it is also exactly the
    // roster of this salon's distribution group - which is what makes the two impossible to drift.
    return members.filter((m) => channelIsReadableBy(channel, m.userId)).map((m) => m.userId);
  }

  /**
   * Whether `userId` may post in `channel`, per its writePolicy:
   *  - `everyone` (default) → any member (access is checked separately);
   *  - `admins_moderators` → roles carrying channel.moderate or workspace.manage;
   *  - `admins` → roles carrying workspace.manage.
   */
  private async canWriteToChannel(channel: Channel, userId: string): Promise<boolean> {
    const policy: ChannelWritePolicy = channel.writePolicy ?? 'everyone';
    if (policy === 'everyone') return true;
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    // THE RULE IS IN `writePolicyAllows` AND NOWHERE ELSE - the listing decides the same thing for
    // the same viewer and must reach the same answer. What is resolved here is only who the viewer
    // IS, which is the part that costs a query.
    //
    // `roleGrantsModeration` rather than a second list of keys: this branch used to check
    // `channel.moderate` and `workspace.manage` and to omit `channel.manage`, which the listing's
    // own `viewerCanModerate` has always counted - so a role holding only `channel.manage` was a
    // moderator everywhere except here.
    return writePolicyAllows(policy, {
      canManage: roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)),
      canModerate: roles.some((r) => this.roleGrantsModeration(r.permissions)),
    });
  }

  /**
   * Who, among `userIds`, may write in `channel` - the same decision {@link canWriteToChannel}
   * enforces and the workspace listing answers, computed for a whole audience at once.
   *
   * TWO QUERIES WHATEVER THE AUDIENCE'S SIZE, because the roles are a property of the workspace and
   * not of the reader: resolving them per user would be one round trip per member of a community
   * every time an administrator saves the access panel.
   *
   * A user the workspace has no member row for gets `false` under a restricted policy - they hold
   * no roles, which is what the policy asks about. Under `everyone` nobody is asked at all.
   */
  private async writeDecisionsFor(
    channel: Channel,
    userIds: string[]
  ): Promise<Map<string, boolean>> {
    const policy: ChannelWritePolicy = channel.writePolicy ?? 'everyone';
    const decisions = new Map<string, boolean>();
    if (policy === 'everyone') {
      for (const id of userIds) decisions.set(id, true);
      return decisions;
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId: channel.workspaceId } });
    const manageRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    const moderateRoleIds = new Set(
      roles.filter((r) => this.roleGrantsModeration(r.permissions)).map((r) => r.id)
    );
    const byUser = new Map(members.map((m) => [m.userId.trim().toLowerCase(), m]));

    for (const id of userIds) {
      const roleIds = byUser.get(id.trim().toLowerCase())?.roleIds ?? [];
      decisions.set(
        id,
        writePolicyAllows(policy, {
          canManage: roleIds.some((r) => manageRoleIds.has(r)),
          canModerate: roleIds.some((r) => moderateRoleIds.has(r)),
        })
      );
    }
    return decisions;
  }

  /**
   * Whether `member` may act on OTHER members' messages in their workspace - the concrete
   * meaning of the `channel.moderate` permission advertised in the role matrix ("pin or delete
   * other members' messages"). MANAGE_CHANNEL and MANAGE_WORKSPACE subsume it.
   *
   * Every moderation entry point (pin, delete, close poll) routes through here so the matrix
   * and the enforcement can never drift apart.
   */
  private async memberCanModerateMessages(member: ChannelMember): Promise<boolean> {
    if (!member.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some((r) => this.roleGrantsModeration(r.permissions));
  }

  /** The permission set that grants message moderation. Single source for enforcement and for the `viewerCanModerate` flag the client gates its UI on. */
  private roleGrantsModeration(permissions: string[]): boolean {
    return (
      permissions.includes(CHANNEL_PERMISSIONS.MANAGE_MESSAGES) ||
      permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
      permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
  }

  // ================= THE GOVERNANCE POSTCONDITION =================
  //
  // Every community operation used to check what the ACTOR may do, and never what the community
  // would be LEFT AS. That is one absent postcondition seen from five sides - leaving, being
  // kicked, being demoted, joining by link, and having one's account deleted - so guarding any of
  // them alone leaves the hole open. Measured on prod 2026-08-17: 15 of 29 communities had exactly
  // one admin and 5 had no members at all.
  //
  // The invariant, enforced server-side as a REFUSAL wherever a refusal is possible:
  //   a community has at least one admin, or it has no members.
  // No repair route exists to put a broken community back, deliberately: making the state
  // unreachable is strictly better than shipping a destructive button that restores it.

  /**
   * The user ids holding an admin role in this workspace, where "admin" means MANAGE_WORKSPACE -
   * the permission that can grant every other one back, and therefore the only one whose
   * disappearance a community cannot recover from on its own.
   *
   * Reads roles then members rather than joining: `channel_members.roleIds` is a `simple-array`
   * text column, so there is no indexable join to make here anyway.
   */
  private async listWorkspaceAdminIds(workspaceId: string): Promise<string[]> {
    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const adminRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    if (adminRoleIds.size === 0) return [];
    const members = await this.memberRepo.find({ where: { workspaceId } });
    return members
      .filter((m) => (m.roleIds ?? []).some((id) => adminRoleIds.has(id)))
      .map((m) => m.userId);
  }

  /**
   * Refuses to remove `targetUserId` when that would leave the community with members and no
   * admin. Shared by leaving and being kicked, which are the same removal seen from two ends.
   *
   * The LAST member leaving is not this case and is allowed: a community with nobody in it is
   * deleted outright rather than left ungoverned - see {@link hardDeleteWorkspace}.
   */
  private async assertRemovalKeepsAnAdmin(
    workspaceId: string,
    targetUserId: string
  ): Promise<void> {
    const adminIds = await this.listWorkspaceAdminIds(workspaceId);
    if (adminIds.length !== 1 || adminIds[0] !== targetUserId) return;

    const memberIds = await this.getWorkspaceMemberIds(workspaceId);
    if (memberIds.every((id) => id === targetUserId)) return;

    this.logger.warn(
      `[WORKSPACE] refused removal of the last admin workspace=${workspaceId} target=${targetUserId.slice(0, 8)} members=${memberIds.length}`
    );
    throw new BadRequestException({
      code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
      message: 'The community would be left with no administrator.',
    });
  }

  /**
   * Stops the community's seeds reaching someone who is about to stop being a member.
   *
   * BEFORE THE MEMBERSHIP ROW GOES, AND ALLOWED TO ABORT THE REMOVAL. The two halves of a departure
   * are not symmetric: this one is immediate and needs nobody online, while removing their MLS leaf
   * is a commit only a remaining member's device can produce, and lands whenever one next loads the
   * community. If this call fails and the removal went through anyway, the leaver would go on being
   * routed every seed frame with no row left anywhere to say they should not be - unfindable and
   * permanent. Failing here instead leaves them a member and the whole departure retryable, which
   * is the only outcome that stays reconcilable (same rule as {@link hardDeleteWorkspace}).
   *
   * Both ends of a removal come through here, because they are the same removal seen from two
   * sides - exactly like {@link assertRemovalKeepsAnAdmin}.
   */
  private async cutOffKeyDistribution(
    workspaceId: string,
    userId: string,
    reason: 'left' | 'kicked'
  ): Promise<void> {
    const cut = await evictFromDistributionGroup(
      this.internalSecret,
      workspaceScope(workspaceId),
      userId
    );
    if (!cut.evicted) {
      // NOT the same line as a cut that found nothing, and the difference is the whole report: a
      // community with no distribution group has no key distribution to stop, while three zeros
      // under the sentence below would read as one that was cut clean. Warn, because on a
      // post-Graine community it means the group is missing and every seed frame is unrouted.
      this.logger.warn(
        `[WORKSPACE] no distribution group to cut workspace=${workspaceId} ` +
          `user=${userId.slice(0, 8)} reason=${reason} - pre-Graine community, or its group is gone`
      );
      return;
    }
    // ALL THREE COUNTS, EACH UNDER ITS OWN NAME. This line used to print `routes=` and pass
    // `memberships`, which read as consistent for as long as the two happened to agree - and the
    // day they did not, it would have named the store it had not measured. Three stores are cut
    // and none stands in for the others: rows are what a reconnect reads, the Redis set is what a
    // live fanout reads, and the queue is what an offline device collects on its next connection.
    this.logger.log(
      `[WORKSPACE] key distribution cut workspace=${workspaceId} user=${userId.slice(0, 8)} ` +
        `reason=${reason} memberships=${cut.memberships} routes=${cut.routes} queued=${cut.queued}`
    );
  }

  /**
   * Gives a PRIVATE salon its own distribution group, or returns the one it already has.
   *
   * BEFORE THE ROW IS CALLED PRIVATE, AND ALLOWED TO ABORT THAT. A salon marked private whose group
   * could not be created is a salon whose seeds have nowhere to go: the client would fall back to
   * nothing, or worse, to the community's group - which is the sharing this whole scope exists to
   * end. Failing here leaves the salon as it was, which is the only state that stays reconcilable
   * (the same rule `createWorkspace` and `hardDeleteWorkspace` already follow).
   *
   * THE PRECONDITION IS THE CALLER'S INTENT, NEVER THE ROW. `channel.isPrivate` is what the salon
   * still IS, and on the public -> private path that is `false` right up to the save this mint has
   * to happen before - so a guard reading the row refused every salon that was becoming private,
   * which is one of the two paths that reaches here. The fact was known at the call site all along;
   * it is passed rather than re-derived from a row that answers a different question.
   *
   * Idempotent on the delivery side through a partial unique index, so a retry costs nothing.
   */
  private async ensureChannelDistributionGroup(
    channel: Channel,
    willBePrivate: boolean
  ): Promise<string> {
    if (!willBePrivate) {
      throw new Error(`ensureChannelDistributionGroup called for public channel ${channel.id}`);
    }
    const groupId = await createDistributionGroup(this.internalSecret, channelScope(channel.id));
    if (channel.distributionGroupId !== groupId) {
      channel.distributionGroupId = groupId;
      await this.channelRepo.save(channel);
    }
    this.logger.log(`[CHANNEL_GRAINE] group ready channel=${channel.id} group=${groupId}`);
    return groupId;
  }

  /**
   * Tombstones a salon's own distribution group, when it stops being private or stops existing.
   *
   * Best-effort ON PURPOSE, unlike every other call in this file, and the asymmetry is the point: a
   * group left behind distributes seeds to a roster nobody consults any more, which is inert, while
   * refusing the archive over it would leave a salon nobody can delete. The line below is what
   * makes the leftover findable - the standing rule is that a swallowed branch logs.
   */
  private async retireChannelDistributionGroup(channel: Channel, reason: string): Promise<void> {
    if (!channel.distributionGroupId) return;
    const groupId = channel.distributionGroupId;
    try {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
      channel.distributionGroupId = null;
      await this.channelRepo.save(channel);
      this.logger.log(
        `[CHANNEL_GRAINE] group retired channel=${channel.id} group=${groupId} reason=${reason}`
      );
    } catch (e) {
      this.logger.error(
        `[CHANNEL_GRAINE] could NOT retire channel=${channel.id} group=${groupId} reason=${reason}: ` +
          `${e instanceof Error ? e.message : String(e)} - the group outlives its salon and must be reaped by hand`
      );
    }
  }

  /**
   * Stops a private salon's seeds reaching someone who may no longer open it.
   *
   * The salon-scoped twin of {@link cutOffKeyDistribution}, and it fails the same way: allowed to
   * abort the removal, because a routing row left behind has nothing that would ever come back for
   * it. A public salon has no group of its own and this is a no-op by construction.
   */
  private async cutOffChannelKeyDistribution(
    channel: Channel,
    userId: string,
    reason: string
  ): Promise<void> {
    if (!channel.isPrivate || !channel.distributionGroupId) return;
    const cut = await evictFromDistributionGroup(
      this.internalSecret,
      channelScope(channel.id),
      userId
    );
    this.logger.log(
      `[CHANNEL_GRAINE] key distribution cut channel=${channel.id} user=${userId.slice(0, 8)} ` +
        `reason=${reason} evicted=${cut.evicted} memberships=${cut.memberships} routes=${cut.routes} queued=${cut.queued}`
    );
  }

  /**
   * Takes one user out of EVERY private salon of a community they are leaving - roster and routing
   * both.
   *
   * The community's own cut says nothing about these: each private salon has its own group and its
   * own routing rows, so a departure that only cut the community's would leave the leaver routed
   * every seed of every private salon they were in. Run for the same reasons and at the same
   * moment, before the membership row goes.
   *
   * THE ROSTER GOES TOO, and that is not tidiness. `allowedUsers` is the authorization, so a leaver
   * still named there would have private access restored the moment they rejoined the community -
   * and, worse, `reconcileDistributionGroupRoster` diffs the MLS tree against exactly this list, so
   * their leaf would be re-authorised at every reconciliation and never removed. A departure that
   * leaves the roster untouched is a departure the tree undoes.
   *
   * PER SALON AND SEQUENTIAL, so one failure aborts the departure rather than half of them. The
   * count is logged even at zero - a sweep that reports nothing is a sweep nobody can tell ran.
   */
  private async cutOffEveryPrivateChannel(
    workspaceId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    const normalised = userId.trim().toLowerCase();
    const privateChannels = await this.channelRepo.find({
      where: { workspaceId, isPrivate: true },
    });
    const held = privateChannels.filter((c) => (c.allowedUsers || []).includes(normalised));
    for (const channel of held) {
      await this.cutOffChannelKeyDistribution(channel, userId, reason);
      channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalised);
      await this.channelRepo.save(channel);
    }
    this.logger.log(
      `[CHANNEL_GRAINE] private salons cut workspace=${workspaceId} user=${userId.slice(0, 8)} ` +
        `reason=${reason} salons=${held.length}/${privateChannels.length}`
    );
  }

  /**
   * Deletes a community and everything under it, for real, in one transaction.
   *
   * There is not ONE foreign key on `channel_workspaces` or `channels`, so nothing cascades and
   * every dependent table has to be named here in dependency order or it becomes orphan rows -
   * which is exactly what the 2026-08-17 purge had to do by hand.
   *
   * Every way a community ends comes through here: the last member leaving, the last member being
   * kicked, an account deletion that empties it, and - since 2026-08-18 - an admin deleting it
   * outright. One ending, one code path, so a table added to the list below is added for all four.
   * Attached media are left to the retention sweep, which collects them within its window once
   * nothing accesses them again.
   */
  private async hardDeleteWorkspace(workspaceId: string, reason: string): Promise<void> {
    const channels = await this.channelRepo.find({
      where: { workspaceId },
      select: { id: true, isPrivate: true, distributionGroupId: true },
    });
    const channelIds = channels.map((c) => c.id);

    // BEFORE the transaction, and allowed to abort it. The distribution group lives in another
    // service, so it cannot join the transaction; doing it afterwards as best-effort would turn a
    // failed call into an orphan group nothing names any more - the very shape of row the
    // 2026-08-17 purge had to find by hand. Failing here leaves the community intact and the whole
    // deletion retryable, which is the only outcome that stays reconcilable.
    await deleteDistributionGroup(this.internalSecret, workspaceScope(workspaceId));

    // EVERY PRIVATE SALON HAS ITS OWN, and the community's deletion says nothing about them. The
    // enumeration is here rather than a cascade because there is not one foreign key on `channels`
    // either - the same reason the transaction below names every table by hand.
    const privateGroups = channels.filter((c) => c.isPrivate && c.distributionGroupId);
    for (const channel of privateGroups) {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
    }

    await this.workspaceRepo.manager.transaction(async (mgr) => {
      await mgr.delete(ChannelMessage, { workspaceId });
      await mgr.delete(ChannelMember, { workspaceId });
      await mgr.delete(ChannelRole, { workspaceId });
      await mgr.delete(WorkspaceInvite, { workspaceId });
      await mgr.delete(Channel, { workspaceId });
      await mgr.delete(Workspace, { id: workspaceId });
    });

    this.logger.log(
      `[WORKSPACE] hard delete workspace=${workspaceId} channels=${channelIds.length} ` +
        `privateGroups=${privateGroups.length} reason=${reason}`
    );
  }

  /**
   * Repairs the communities a deleted account leaves behind. Called by the internal account
   * deletion route with the workspaces the user belonged to, AFTER their membership rows are gone.
   *
   * This is the one path where the postcondition cannot be a refusal - the account is being
   * deleted and there is nothing left to refuse - so it is the one place a repair exists, and it
   * is deterministic rather than a heuristic:
   *  - no members left: the community is deleted, exactly as if the last member had left;
   *  - members but no admin: the highest-priority remaining role holder is promoted, ties broken by
   *    the lowest user id. Deleting other people's community because one person deleted their
   *    account would be far worse, and leaving it ungoverned is the state everything else here
   *    exists to prevent.
   *
   * Per workspace isolation: one community failing to repair must not strand the others, and a
   * swallowed branch that logs nothing would leave no trace at all of what was skipped.
   *
   * `deletedUserId` is carried because the private salons still name them. Their `channel_members`
   * row is already gone when this runs, but `allowedUsers` is a separate list and nothing above has
   * touched it - and `reconcileDistributionGroupRoster` reads exactly that list, so a deleted
   * account left in it keeps an MLS leaf authorised forever, on a group whose seeds nobody can now
   * be routed. The repair is the only place left that knows who it was.
   */
  async repairWorkspacesAfterAccountDeletion(
    workspaceIds: string[],
    deletedUserId: string
  ): Promise<void> {
    for (const workspaceId of workspaceIds) {
      try {
        await this.cutOffEveryPrivateChannel(workspaceId, deletedUserId, 'account_deleted');
        await this.repairOneWorkspaceAfterAccountDeletion(workspaceId);
      } catch (err) {
        this.logger.error(
          `[WORKSPACE] repair failed workspace=${workspaceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async repairOneWorkspaceAfterAccountDeletion(workspaceId: string): Promise<void> {
    const members = await this.memberRepo.find({ where: { workspaceId } });
    if (members.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'account_deletion_left_no_members');
      return;
    }

    const adminIds = await this.listWorkspaceAdminIds(workspaceId);
    if (adminIds.length > 0) return;

    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const adminRole = roles
      .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
      .sort((a, b) => b.priority - a.priority)[0];
    if (!adminRole) {
      // Nothing to promote anyone INTO. Reported rather than swallowed: a community whose roles no
      // longer include MANAGE_WORKSPACE is a data fault this route cannot fix by itself.
      this.logger.error(
        `[WORKSPACE] cannot promote a successor workspace=${workspaceId} - no role carries MANAGE_WORKSPACE`
      );
      return;
    }

    const priorityOf = new Map(roles.map((r) => [r.id, r.priority]));
    const rankOf = (m: ChannelMember): number =>
      Math.max(0, ...(m.roleIds ?? []).map((id) => priorityOf.get(id) ?? 0));
    const successor = members
      .slice()
      .sort((a, b) => rankOf(b) - rankOf(a) || a.userId.localeCompare(b.userId))[0];

    successor.roleIds = [adminRole.id];
    await this.memberRepo.save(successor);
    this.logger.warn(
      `[WORKSPACE] promoted a successor admin workspace=${workspaceId} user=${successor.userId.slice(0, 8)} role="${adminRole.name}" members=${members.length} reason=account_deletion`
    );
  }

  constructor(
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>,
    @InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>,
    @InjectRepository(WorkspaceInvite)
    private readonly inviteRepo: Repository<WorkspaceInvite>,
    private readonly redis: RedisService
  ) {}

  // ================= INVITES (shareable community links) =================

  /** True when the actor holds a workspace permission allowing invite-link creation. */
  private async actorCanInvite(workspaceId: string, actorUserId: string): Promise<boolean> {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId: actorUserId } });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some(
      (r) =>
        r.permissions.includes(CHANNEL_PERMISSIONS.INVITE_MEMBERS) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
  }

  /** Whether an invite is still usable (not revoked/expired/exhausted). */
  private inviteIsValid(invite: WorkspaceInvite): boolean {
    if (invite.revoked) return false;
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return false;
    if (invite.maxUses != null && invite.uses >= invite.maxUses) return false;
    return true;
  }

  /** Revokes a set of invites in one statement, saying how many and why. */
  private async revokeInvites(invites: WorkspaceInvite[], reason: string): Promise<void> {
    if (invites.length === 0) return;
    await this.inviteRepo.update({ id: In(invites.map((i) => i.id)) }, { revoked: true });
    this.logger.log(`[INVITE] revoked count=${invites.length} reason=${reason}`);
  }

  /** The shape of an invite the UI needs: the token plus the bounds it was minted with. */
  private toInviteDto(invite: WorkspaceInvite): WorkspaceInviteDto {
    return {
      token: invite.token,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      maxUses: invite.maxUses,
      uses: invite.uses,
    };
  }

  /**
   * Returns THE community's invite link, minting one if it has none.
   * Requires the actor to hold INVITE_USERS or MANAGE_WORKSPACE in the workspace.
   *
   * There used to be no "the". This documented itself as "creates (or returns)" and only ever
   * created, while the UI called it on every click - so one member minted 3 valid tokens for the
   * same community in 59 seconds, of which one was ever used. Revoking the link you shared revoked
   * nothing, because the other two still worked and nobody knew they existed. A community now has
   * at most ONE live invite, which makes "the link" an object a human can reason about.
   *
   * `rotate` is the only way to get a new token: it revokes whatever is live and mints its
   * replacement. Without it the existing link is returned unchanged, bounds included, so opening
   * the panel never silently invalidates what somebody already shared.
   *
   * `expiresAt` and `maxUses` were honoured by {@link inviteIsValid} all along and simply never
   * surfaced - all 10 live invites on prod carried NULL for both, so every link ever shared was
   * eternal and unlimited.
   */
  async createWorkspaceInvite(
    workspaceId: string,
    actorUserId: string,
    opts?: { expiresAt?: string | null; maxUses?: number | null; rotate?: boolean }
  ): Promise<WorkspaceInviteDto> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (!(await this.actorCanInvite(workspaceId, actorUserId))) {
      throw new ForbiddenException('Missing INVITE_USERS permission');
    }

    const live = (await this.inviteRepo.find({ where: { workspaceId, revoked: false } }))
      .filter((i) => this.inviteIsValid(i))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (!opts?.rotate && live.length > 0) {
      // Several may still be live from before this rule. The most recent is the one a human most
      // plausibly shared last; the rest are revoked so the singular becomes true again.
      await this.revokeInvites(live.slice(1), 'superseded_by_newest');
      return this.toInviteDto(live[0]);
    }

    await this.revokeInvites(live, 'rotated');

    const expiresAt = this.parseInviteExpiry(opts?.expiresAt);
    const maxUses = this.parseInviteMaxUses(opts?.maxUses);
    const saved = await this.inviteRepo.save(
      this.inviteRepo.create({
        workspaceId,
        token: crypto.randomBytes(18).toString('base64url'),
        createdBy: actorUserId,
        expiresAt,
        maxUses,
        uses: 0,
        revoked: false,
      })
    );
    this.logger.log(
      `[INVITE] created workspace=${workspaceId} by=${actorUserId.slice(0, 8)} expiresAt=${expiresAt?.toISOString() ?? 'never'} maxUses=${maxUses ?? 'unlimited'} replaced=${live.length}`
    );
    return this.toInviteDto(saved);
  }

  /**
   * Validates an expiry sent by a client. A date the server cannot parse, or one already in the
   * past, is refused rather than stored: `inviteIsValid` would treat an unparseable Date as expired
   * and the caller would be handed a token that is dead on arrival, with nothing saying why.
   */
  private parseInviteExpiry(raw?: string | null): Date | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException({
        code: 'INVITE_EXPIRY_INVALID',
        message: 'expiresAt is not a valid date',
      });
    }
    if (parsed.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'INVITE_EXPIRY_IN_THE_PAST',
        message: 'expiresAt is already in the past',
      });
    }
    return parsed;
  }

  /** Validates a use cap. Zero or negative would mint a link nobody can ever use. */
  private parseInviteMaxUses(raw?: number | null): number | null {
    if (raw === undefined || raw === null) return null;
    if (!Number.isInteger(raw) || raw < 1) {
      throw new BadRequestException({
        code: 'INVITE_MAX_USES_INVALID',
        message: 'maxUses must be a positive integer',
      });
    }
    return raw;
  }

  /** Public-ish preview of an invite (community name/image) shown before the user joins. */
  async getWorkspaceInvitePreview(token: string): Promise<{
    valid: boolean;
    workspaceName: string | null;
    workspaceSlug: string | null;
    imageMediaId: string | null;
  }> {
    const invite = await this.inviteRepo.findOne({ where: { token } });
    if (!invite || !this.inviteIsValid(invite)) {
      return { valid: false, workspaceName: null, workspaceSlug: null, imageMediaId: null };
    }
    const ws = await this.workspaceRepo.findOne({
      where: { id: invite.workspaceId },
    });
    if (!ws) return { valid: false, workspaceName: null, workspaceSlug: null, imageMediaId: null };
    return {
      valid: true,
      workspaceName: ws.name,
      workspaceSlug: ws.slug,
      imageMediaId: ws.imageMediaId,
    };
  }

  /**
   * Joins the caller into the invite's community: adds a workspace member with the base role.
   * The client fetches channel keys via the existing bootstrap once it loads the workspace.
   */
  async acceptWorkspaceInvite(
    token: string,
    userId: string
  ): Promise<{ workspaceSlug: string; alreadyMember: boolean }> {
    const invite = await this.inviteRepo.findOne({ where: { token } });
    if (!invite || !this.inviteIsValid(invite)) {
      throw new NotFoundException('Invalid or expired invitation.');
    }
    // Links outlive the community they point at: an invite to a deleted community must not
    // resurrect it for the joiner.
    const ws = await this.workspaceRepo.findOne({
      where: { id: invite.workspaceId },
    });
    if (!ws) throw new NotFoundException('Workspace not found');

    // A link outlives the membership that minted it. Joining a community nobody belongs to any more
    // would produce the one state nothing can repair from inside - members, and no admin among
    // them - out of a forwarded URL. Leaving now deletes such a community outright, but account
    // deletion still removes membership rows directly (`internal.controller`), so this is a live
    // guard rather than a leftover.
    const memberIdsBeforeJoin = await this.getWorkspaceMemberIds(ws.id);
    if (memberIdsBeforeJoin.length === 0) {
      this.logger.warn(`[INVITE] refused - workspace=${ws.id} has no members left`);
      throw new NotFoundException({
        code: 'WORKSPACE_HAS_NO_MEMBERS',
        message: 'This community no longer exists.',
      });
    }

    const existing = await this.memberRepo.findOne({
      where: { workspaceId: ws.id, userId },
    });
    if (existing) return { workspaceSlug: ws.slug, alreadyMember: true };

    // Base member role = lowest priority role of the workspace (e.g. "Membre").
    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });
    const baseRole = roles.slice().sort((a, b) => a.priority - b.priority)[0] ?? null;
    await this.memberRepo.save(
      this.memberRepo.create({
        workspaceId: ws.id,
        userId,
        roleIds: baseRole ? [baseRole.id] : [],
      })
    );

    await this.inviteRepo.increment({ id: invite.id }, 'uses', 1);

    // Notify connected clients (the joining user's devices + existing members) to refresh.
    const repChannel = await this.channelRepo.findOne({
      where: { workspaceId: ws.id, isPrivate: false },
    });
    if (repChannel) {
      const memberIds = await this.getWorkspaceMemberIds(ws.id);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId: repChannel.id,
          channelName: repChannel.name,
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          workspaceName: ws.name,
          visibility: 'public',
          roleName: baseRole?.name ?? 'Membre',
          joinedBy: userId,
        },
        memberIds
      );
    }
    this.logger.log(`[INVITE] accepted workspace=${ws.id} user=${userId.slice(0, 8)}`);
    return { workspaceSlug: ws.slug, alreadyMember: false };
  }

  /**
   * Get all user IDs in a workspace for event broadcasting.
   */
  private async getWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
    const members = await this.memberRepo.find({ where: { workspaceId } });
    return members.map((m) => m.userId);
  }

  /**
   * Of the Graine sessions a device holds, which ones this server still has messages for.
   *
   * THE SEEDS' RETENTION WINDOW IS THIS ONE, DERIVED - never a second clock on the device. A seed
   * whose messages are gone is the keys to something that no longer exists: unbounded, and pure
   * liability. But a device cannot know when a message was deleted, and giving it its own one-year
   * timer would be a second copy of a number that lives here - which is precisely the shape that
   * drifts, and would strip the seed of a PINNED message the sweep deliberately kept.
   *
   * Answers only about ids the caller submitted, and only from the communities it belongs to. A
   * session id is opaque and unique across senders, so the reply reveals nothing the caller did not
   * already hold: it learns whether ITS OWN seed is still worth keeping, and nothing about anyone
   * else's. An id the caller does not belong to is simply absent from the answer, indistinguishable
   * from one that has expired - there is no membership oracle here.
   *
   * @param userId the asking account, from `x-user-id`
   * @param sessionIds sessions the device holds; anything beyond {@link MAX_LIVE_SESSION_QUERY} is
   *   refused rather than silently truncated, since a truncated answer reads as "these are dead"
   * @returns the subset still named by at least one stored message
   */
  async liveGraineSessions(userId: string, sessionIds: string[]): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    if (sessionIds.length > MAX_LIVE_SESSION_QUERY) {
      throw new BadRequestException(
        `At most ${MAX_LIVE_SESSION_QUERY} session ids per request, got ${sessionIds.length}`
      );
    }

    const memberships = await this.memberRepo.find({
      where: { userId },
      select: { workspaceId: true },
    });
    if (memberships.length === 0) return [];
    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];

    const rows: { senderSessionId: string }[] = await this.messageRepo
      .createQueryBuilder('m')
      .select('DISTINCT m."senderSessionId"', 'senderSessionId')
      .where('m."senderSessionId" IN (:...sessionIds)', { sessionIds })
      .andWhere('m."workspaceId" IN (:...workspaceIds)', { workspaceIds })
      .getRawMany();

    const live = rows.map((r) => r.senderSessionId);
    this.logger.debug(
      `[GRAINE] liveGraineSessions user=${userId.slice(0, 8)} asked=${sessionIds.length} live=${live.length}`
    );
    return live;
  }

  // ================= WORKSPACES =================

  /** Creates a workspace with default Administrateur/Modérateur/Membre roles, adds the creator as admin, and creates a public #general channel. */
  /**
   * Returns a workspace slug guaranteed free of collisions with existing communities.
   * Communities may share a display name, but `channel_workspaces.slug`
   * has a unique constraint and is used for URL lookups, so a numeric suffix (`-2`, `-3`, …)
   * is appended when the requested slug is already taken.
   */
  private async ensureUniqueWorkspaceSlug(requested: string): Promise<string> {
    const base = requested.trim();
    if (!base) throw new BadRequestException('Slug de communaute invalide.');

    let candidate = base;
    for (let suffix = 2; ; suffix++) {
      const existing = await this.workspaceRepo.findOne({ where: { slug: candidate } });
      if (!existing) return candidate;
      candidate = `${base}-${suffix}`;
    }
  }

  async createWorkspace(input: CreateWorkspaceDto) {
    const slug = await this.ensureUniqueWorkspaceSlug(input.slug);
    this.logger.log(
      `[WORKSPACE] create name="${input.name}" slug="${slug}" (requested="${input.slug}") by=${input.createdBy.slice(0, 8)}`
    );
    const ws = this.workspaceRepo.create({
      name: input.name,
      slug,
      createdBy: input.createdBy,
    });
    const savedWs = await this.workspaceRepo.save(ws);

    // THE DISTRIBUTION GROUP IS CREATED WITH THE COMMUNITY, NOT ON FIRST USE. A community whose
    // seeds have nowhere to travel is a community whose salons cannot be encrypted, so this is not
    // a decoration that may degrade: it fails the creation. The row is unwound first, because a
    // half-created community would hold its slug hostage while being unusable, and the migration
    // to Graine is a clean cut - there is no population of older communities to be gentle with.
    try {
      savedWs.distributionGroupId = await createDistributionGroup(
        this.internalSecret,
        workspaceScope(savedWs.id)
      );
      await this.workspaceRepo.save(savedWs);
    } catch (e) {
      await this.workspaceRepo.delete({ id: savedWs.id });
      this.logger.error(
        `[WORKSPACE] create ROLLED BACK workspace=${savedWs.id} slug="${slug}" - no distribution group: ${e instanceof Error ? e.message : String(e)}`
      );
      throw e;
    }
    this.logger.log(
      `[WORKSPACE] distribution group workspace=${savedWs.id} group=${savedWs.distributionGroupId}`
    );

    const adminRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Administrateur',
      priority: 100,
      permissions: DEFAULT_ADMIN_PERMISSIONS as string[],
    });
    const savedAdminRole = await this.roleRepo.save(adminRole);

    const moderatorRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Modérateur',
      priority: 50,
      permissions: DEFAULT_MODERATOR_PERMISSIONS as string[],
    });
    await this.roleRepo.save(moderatorRole);

    const memberRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Membre',
      priority: 10,
      permissions: DEFAULT_MEMBER_PERMISSIONS as string[],
    });
    await this.roleRepo.save(memberRole);

    const adminMember = this.memberRepo.create({
      workspaceId: savedWs.id,
      userId: input.createdBy,
      roleIds: [savedAdminRole.id],
    });
    await this.memberRepo.save(adminMember);

    const generalChannel = this.channelRepo.create({
      workspaceId: savedWs.id,
      name: 'general',
      isPrivate: false,
    });
    await this.channelRepo.save(generalChannel);

    return { ...savedWs, viewerCanManage: true };
  }

  /**
   * Establishes that `userId` belongs to a live community, and returns it.
   *
   * The single gate in front of everything Graine: the GroupInfo it guards IS the capability to
   * enter the distribution group and read every seed on it, so this decides who may hold one. It
   * lives here because `channel_workspace_members` lives here - chat-delivery cannot answer this
   * question about a table it does not own, and would have had to ask anyway.
   */
  private async assertWorkspaceMember(workspaceId: string, userId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) {
      this.logger.warn(
        `[DISTRIBUTION_GROUP] refused workspace=${workspaceId} user=${userId.slice(0, 8)} - not a member`
      );
      throw new ForbiddenException('Not a member of this workspace');
    }
    return workspace;
  }

  /**
   * Hands a community member its distribution group and the latest GroupInfo published on it, so
   * the client can external-join and start receiving channel seeds.
   *
   * `groupInfo: null` means nobody has initialised the MLS group yet - the FIRST caller to see it
   * is the one that creates it and publishes back through
   * {@link publishDistributionGroupInfoForMember}. That is a state the client must be able to act
   * on, which is why it is a null field and not an error.
   */
  async getDistributionGroupForMember(
    workspaceId: string,
    userId: string
  ): Promise<DistributionGroupRef> {
    await this.assertWorkspaceMember(workspaceId, userId);

    const ref = await readDistributionGroup(
      this.internalSecret,
      workspaceScope(workspaceId),
      userId
    );
    if (!ref) {
      // Every community created since WP-21 has one, and the clean cut leaves no older population.
      // So this is not a state to repair silently: it is a community that cannot carry seeds, and
      // saying so is what makes it findable.
      this.logger.error(
        `[DISTRIBUTION_GROUP] workspace=${workspaceId} has NO distribution group - salons in it cannot be encrypted`
      );
      throw new NotFoundException({
        code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP',
        message: 'This community has no key distribution group.',
      });
    }

    this.logger.log(
      `[DISTRIBUTION_GROUP] served workspace=${workspaceId} user=${userId.slice(0, 8)} group=${ref.groupId} published=${ref.groupInfo !== null} devices=${ref.memberDevices?.length ?? '?'}`
    );
    return ref;
  }

  /**
   * Publishes a member's freshly committed GroupInfo for the community's distribution group.
   * Monotonic on the delivery side, so a late refresh can never regress the served base epoch.
   */
  async publishDistributionGroupInfoForMember(
    workspaceId: string,
    userId: string,
    groupInfo: string,
    baseEpoch: number,
    deviceId: string
  ): Promise<{ stored: boolean }> {
    await this.assertWorkspaceMember(workspaceId, userId);

    const result = await publishDistributionGroupInfo(
      this.internalSecret,
      workspaceScope(workspaceId),
      groupInfo,
      baseEpoch,
      { userId, deviceId }
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] published workspace=${workspaceId} user=${userId.slice(0, 8)} epoch=${baseEpoch} stored=${result.stored}`
    );
    return result;
  }

  /**
   * The channel a caller may read, or a refusal - the gate in front of every salon-scoped seed
   * route.
   *
   * PRIVATE ONLY, and asking about a public salon is refused rather than answered with the
   * community's group. A public salon's audience IS the community, so it carries no group of its
   * own; answering with the community's would let a client believe a per-salon roster exists where
   * none does, which is precisely the confusion this scope was added to end. The refusal is a 400,
   * not a 403: nothing about the caller is wrong.
   */
  /**
   * The channel, once `userId` has been shown to be allowed to READ it.
   *
   * The question every Graine route asks first, and it is asked of the channel rather than of the
   * community: being in the community is not being in a private salon, and the two used to be the
   * same query.
   */
  private async assertChannelReader(channelId: string, userId: string): Promise<Channel> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      this.logger.warn(
        `[CHANNEL_GRAINE] refused channel=${channelId} user=${userId.slice(0, 8)} - no access`
      );
      throw new ForbiddenException('No access to this channel');
    }
    return channel;
  }

  private async assertPrivateChannelReader(channelId: string, userId: string): Promise<Channel> {
    const channel = await this.assertChannelReader(channelId, userId);

    if (!channel.isPrivate) {
      throw new BadRequestException({
        code: 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP',
        message: 'A public salon uses the community distribution group.',
      });
    }
    return channel;
  }

  /**
   * Hands a private salon's reader its OWN distribution group and the latest GroupInfo on it.
   *
   * The salon-scoped twin of {@link getDistributionGroupForMember}, and the reason the roster is
   * finite: only the people in `allowedUsers` - plus the admins who have explicitly joined - ever
   * see this GroupInfo, and the GroupInfo IS the capability to external-join. An admin who has not
   * joined is refused here exactly like anyone else, which is what stops `workspace.manage` from
   * being a standing key to every private salon.
   */
  async getChannelDistributionGroupForMember(
    channelId: string,
    userId: string
  ): Promise<DistributionGroupRef> {
    await this.assertPrivateChannelReader(channelId, userId);

    const ref = await readDistributionGroup(this.internalSecret, channelScope(channelId), userId);
    if (!ref) {
      // Every private salon is given one at birth and cannot be created without it, so this is not
      // a state to repair silently: it is a salon that cannot carry seeds.
      this.logger.error(
        `[CHANNEL_GRAINE] channel=${channelId} is private with NO distribution group - it cannot be encrypted`
      );
      throw new NotFoundException({
        code: 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP',
        message: 'This salon has no key distribution group.',
      });
    }

    this.logger.log(
      `[CHANNEL_GRAINE] served channel=${channelId} user=${userId.slice(0, 8)} group=${ref.groupId} published=${ref.groupInfo !== null} devices=${ref.memberDevices?.length ?? '?'}`
    );
    return ref;
  }

  /**
   * The lowest message index of each named session that `forUserId` arrived in time to read.
   *
   * **THE PART OF `historyVisibility` NO CLIENT CAN COMPUTE.** A community set to `joined` promises
   * that nothing said before a member arrived is readable by them, and the seed layer enforces it
   * where a seed leaves a device. But a Graine session can SPAN an arrival: rotation is decided by
   * the SENDER when it notices the distribution group's epoch has moved, and a join is an external
   * commit, so the sender learns of it late and seals a few more messages under the session it
   * already had. Withholding that whole session costs the newcomer messages sent AFTER they
   * arrived; handing it over whole gives them the ones sent before. Only a floor can express the
   * difference, and `firstIndex` is exactly the field that carries one.
   *
   * **The floor is computed HERE because only here are both halves authoritative.** The arrival is
   * this server's own `channel_members.createdAt` and the message dates are its own `createdAt`, so
   * the comparison is between two values written by ONE clock - where a client comparing a
   * server-stamped arrival with a peer's device-stamped mint time is sharp only to that peer's clock
   * skew. And because the answer is derived from stored rows rather than from any caller's opinion,
   * every device that asks gets the same number for the same state: neither the member answering nor
   * the member asking supplies anything the result depends on.
   *
   * The caller must be able to READ the channel; `forUserId` must be a member of its community. A
   * session with no message at or after the arrival is absent from the result, which means withhold
   * it entirely - the distinction between "nothing to give" and "give from index k" is the whole
   * point, so it is carried as presence rather than as a zero.
   *
   * @param channelId Channel the sessions belong to.
   * @param callerId Who is asking - a reader of the channel, i.e. the member about to hand a seed over.
   * @param forUserId Whose arrival draws the floor.
   * @param sessionIds Sessions the repair request named.
   * @returns `sessionId -> lowest readable index`, omitting sessions with nothing readable.
   */
  async getGraineHistoryFloors(
    channelId: string,
    callerId: string,
    forUserId: string,
    sessionIds: string[]
  ): Promise<Record<string, number>> {
    const channel = await this.assertChannelReader(channelId, callerId);

    const arrival = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: forUserId },
      select: { createdAt: true },
    });
    if (!arrival) {
      // Not a member, so there is no arrival to measure from and nothing they may be handed. Said
      // as a refusal rather than as an empty result: the caller must fail closed, and an empty
      // object is what a community with no matching messages also looks like.
      throw new ForbiddenException('That user is not a member of this community');
    }
    if (sessionIds.length === 0) return {};

    const rows: { sessionId: string; floor: string }[] = await this.messageRepo
      .createQueryBuilder('m')
      .select('m."senderSessionId"', 'sessionId')
      .addSelect('MIN(m."messageIndex")', 'floor')
      .where('m."channelId" = :channelId', { channelId })
      .andWhere('m."senderSessionId" IN (:...sessionIds)', { sessionIds })
      // A row with no index answers no key derivation, so it can never be the floor of anything.
      .andWhere('m."messageIndex" IS NOT NULL')
      .andWhere('m."createdAt" >= :arrival', { arrival: arrival.createdAt })
      .groupBy('m."senderSessionId"')
      .getRawMany();

    const floors: Record<string, number> = {};
    for (const row of rows) floors[row.sessionId] = Number(row.floor);
    this.logger.log(
      `[CHANNEL_GRAINE] floors channel=${channelId} for=${forUserId.slice(0, 8)} ` +
        `asked=${sessionIds.length} readable=${rows.length}`
    );
    return floors;
  }

  /** Publishes a reader's freshly committed GroupInfo for a private salon's distribution group. */
  async publishChannelDistributionGroupInfoForMember(
    channelId: string,
    userId: string,
    groupInfo: string,
    baseEpoch: number,
    deviceId: string
  ): Promise<{ stored: boolean }> {
    await this.assertPrivateChannelReader(channelId, userId);

    const result = await publishDistributionGroupInfo(
      this.internalSecret,
      channelScope(channelId),
      groupInfo,
      baseEpoch,
      { userId, deviceId }
    );
    this.logger.log(
      `[CHANNEL_GRAINE] published channel=${channelId} user=${userId.slice(0, 8)} epoch=${baseEpoch} stored=${result.stored}`
    );
    return result;
  }

  /**
   * Puts an administrator into a private salon they can see but cannot read, ON PURPOSE and BY
   * NAME.
   *
   * WHY THIS EXISTS AT ALL. `workspace.manage` used to be a silent bypass: an admin could read
   * every private salon and appeared in none of their rosters. That made the roster infinite - it
   * was `allowedUsers` plus whoever happened to hold an admin role at the time - and an infinite
   * roster cannot be an MLS group, because every seed would have to be sealed to a set that
   * changes without anyone touching the salon. Making the join EXPLICIT is what makes the set
   * finite and the guarantee cryptographic rather than server-enforced.
   *
   * NO SYSTEM MESSAGE, on the user's decision of 2026-08-19: the admin shows up in the member list
   * and that is the whole disclosure. A message in the transcript would be a permanent record of a
   * moderation act in a conversation the moderator is there to read, which is a different product
   * decision from the one being made here.
   *
   * Idempotent: an admin already in the roster gets the same answer and no second event.
   */
  async joinPrivateChannelAsAdmin(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (!channel.isPrivate) {
      throw new BadRequestException({
        code: 'CHANNEL_IS_PUBLIC',
        message: 'A public salon is already readable by every member.',
      });
    }

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const roles = member.roleIds?.length
      ? await this.roleRepo.find({ where: { id: In(member.roleIds) } })
      : [];
    if (!roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))) {
      this.logger.warn(
        `[CHANNEL_GRAINE] refused admin join channel=${channelId} user=${actorUserId.slice(0, 8)} - no MANAGE_WORKSPACE`
      );
      throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');
    }

    const normalized = actorUserId.trim().toLowerCase();
    if ((channel.allowedUsers || []).includes(normalized)) {
      return { success: true, alreadyMember: true };
    }

    // GRANTED BEFORE ANNOUNCED, like every other grant here: the audience is derived from
    // `allowedUsers`, so the joiner would otherwise be the one person the event misses.
    channel.allowedUsers = [...(channel.allowedUsers || []), normalized];
    await this.channelRepo.save(channel);

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.member.joined',
      {
        channelId,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        visibility: 'private',
        roleName: 'Administrateur',
        joinedBy: actorUserId,
        invitedBy: actorUserId,
      },
      audience
    );

    this.logger.log(
      `[CHANNEL_GRAINE] admin joined channel=${channelId} user=${actorUserId.slice(0, 8)} roster=${channel.allowedUsers.length}`
    );
    return { success: true, alreadyMember: false };
  }

  /**
   * Loads a workspace by its URL slug together with the channels the caller may read, its
   * members, and its roles. `viewerCanManage` / `viewerCanModerate` are computed server-side so
   * the frontend can gate admin controls without deriving permissions itself.
   *
   * Members only: a slug is public knowledge (every invite link and its preview hands one out),
   * so it must not be enough to read a community's roster or channel list from the outside.
   */
  async getWorkspaceBySlug(slug: string, userId: string) {
    // A deleted community is a 404 on its own slug because there is no row, not because a
    // filter hides one. It was the other way round until deletion became real.
    const ws = await this.workspaceRepo.findOne({ where: { slug } });
    if (!ws) throw new NotFoundException('Workspace not found');

    const normalizedUserId = (userId ?? '').trim().toLowerCase();
    const members = await this.memberRepo.find({ where: { workspaceId: ws.id } });
    const viewerMember = members.find((m) => m.userId.trim().toLowerCase() === normalizedUserId);
    if (!viewerMember) throw new ForbiddenException('Not a member of this workspace');

    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });

    const allChannels = await this.channelRepo.find({ where: { workspaceId: ws.id } });
    // RESOLVED BEFORE THE CHANNEL LOOP, because it now decides what goes IN it. An admin has no
    // access to a private salon they have not joined, so without this they would not see it exists
    // and could never join it - a capability nobody can reach is not a capability.
    let viewerCanManage = false;
    let viewerCanModerate = false;
    if (viewerMember.roleIds?.length) {
      const manageRoleIds = new Set(
        roles
          .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
          .map((r) => r.id)
      );
      const moderateRoleIds = new Set(
        roles.filter((r) => this.roleGrantsModeration(r.permissions)).map((r) => r.id)
      );
      viewerCanManage = viewerMember.roleIds.some((id) => manageRoleIds.has(id));
      viewerCanModerate = viewerMember.roleIds.some((id) => moderateRoleIds.has(id));
    }

    const channels: Array<{
      id: string;
      workspaceId: string;
      name: string;
      visibility: 'public' | 'private';
      writePolicy: ChannelWritePolicy;
      viewerHasAccess: boolean;
      viewerCanWrite: boolean;
    }> = [];
    for (const ch of allChannels) {
      const hasAccess = this.canAccessChannel(ch, viewerMember, normalizedUserId);
      // An admin is shown a private salon they have not joined - its NAME and nothing else. No
      // message, no roster, no seed: every one of those goes through `canAccessChannel`, which
      // still says no. This row exists so the join is reachable, and it is the only thing that
      // leaks - a salon's existence, to someone who could add themselves to it in one click
      // anyway.
      if (!hasAccess && !viewerCanManage) continue;
      // Projected field by field, never the entity: a channel row carries columns no caller needs,
      // and serializing the entity handed every one of them to the client.
      channels.push({
        id: ch.id,
        workspaceId: ch.workspaceId,
        name: ch.name,
        visibility: ch.isPrivate ? 'private' : 'public',
        writePolicy: ch.writePolicy ?? 'everyone',
        viewerHasAccess: hasAccess,
        // ANSWERED HERE BECAUSE IT IS ALREADY KNOWN HERE. `writePolicy` alone does not tell a
        // client whether IT may write - that needs the viewer's roles, which this listing has just
        // resolved for the workspace. Sending the policy and letting each client re-derive the rest
        // would be a second copy of the rule, and the client holds no roles to derive it from.
        viewerCanWrite: writePolicyAllows(ch.writePolicy ?? 'everyone', {
          canManage: viewerCanManage,
          canModerate: viewerCanModerate,
        }),
      });
    }

    return { workspace: { ...ws, viewerCanManage, viewerCanModerate }, channels, members, roles };
  }

  /** Returns all workspaces the user belongs to (derived from their ChannelMember records). */
  async listWorkspacesForUser(userId: string) {
    const memberships = await this.memberRepo.find({ where: { userId } });
    if (memberships.length === 0) return [];

    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
    // A DELETED COMMUNITY LEAVES NO ROW IN ANY OF THESE TABLES, membership included, so an id
    // that resolves to nothing is the ordinary shape of one that is gone rather than a filtered
    // tombstone. This comment said the opposite until 2026-08-20 - it was written for the soft
    // delete and outlived it by two days, which is how a stale comment lies: it named a mechanism
    // (`archived`) that `hardDeleteWorkspace` had already made incapable of removing anything.
    const workspaces = await this.workspaceRepo.find({ where: { id: In(workspaceIds) } });

    // Derive per-workspace management rights server-side so the client can gate admin
    // controls (e.g. "change image", invite) without deriving permissions itself. We
    // batch-load every role referenced across the user's memberships to avoid an N+1
    // query, then flag each workspace where a held role carries MANAGE_WORKSPACE.
    const allRoleIds = [...new Set(memberships.flatMap((m) => m.roleIds ?? []))];
    const roles = allRoleIds.length
      ? await this.roleRepo.find({ where: { id: In(allRoleIds) } })
      : [];
    const manageRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    // Moderation is a separate, weaker grant: it lets the client offer "delete this message"
    // on someone else's message without having to probe the API for a 403.
    const moderateRoleIds = new Set(
      roles.filter((r) => this.roleGrantsModeration(r.permissions)).map((r) => r.id)
    );
    const canManageByWorkspace = new Map<string, boolean>();
    const canModerateByWorkspace = new Map<string, boolean>();
    for (const membership of memberships) {
      const canManage = (membership.roleIds ?? []).some((id) => manageRoleIds.has(id));
      const canModerate = (membership.roleIds ?? []).some((id) => moderateRoleIds.has(id));
      // A user may hold several membership rows for the same workspace; any one row
      // bearing a MANAGE_WORKSPACE role is enough to manage it.
      canManageByWorkspace.set(
        membership.workspaceId,
        (canManageByWorkspace.get(membership.workspaceId) ?? false) || canManage
      );
      canModerateByWorkspace.set(
        membership.workspaceId,
        (canModerateByWorkspace.get(membership.workspaceId) ?? false) || canModerate
      );
    }

    // Personal display order: pick the lowest sortOrder across a user's membership rows
    // for a workspace (normally just one row per workspace, given the unique index).
    const sortOrderByWorkspace = new Map<string, number>();
    for (const membership of memberships) {
      const current = sortOrderByWorkspace.get(membership.workspaceId);
      if (current === undefined || membership.sortOrder < current) {
        sortOrderByWorkspace.set(membership.workspaceId, membership.sortOrder);
      }
    }

    return workspaces
      .map((w) => ({
        ...w,
        id: w.id,
        viewerCanManage: canManageByWorkspace.get(w.id) ?? false,
        viewerCanModerate: canModerateByWorkspace.get(w.id) ?? false,
      }))
      .sort(
        (a, b) => (sortOrderByWorkspace.get(a.id) ?? 0) - (sortOrderByWorkspace.get(b.id) ?? 0)
      );
  }

  /**
   * Persists the calling user's personal top-to-bottom order for their communities.
   * Ids absent from `orderedIds` keep their previous sortOrder (sort after the reordered ones).
   */
  async reorderWorkspacesForUser(userId: string, orderedIds: string[]): Promise<void> {
    this.logger.debug(`reorder ${orderedIds.length} workspaces for user=${userId}`);
    await Promise.all(
      orderedIds.map((workspaceId, index) =>
        this.memberRepo.update({ userId, workspaceId }, { sortOrder: index })
      )
    );
  }

  // ================= ROLES =================

  /** Creates a new workspace role. Only members with MANAGE_WORKSPACE or MANAGE_ROLES permission may call this. */
  async createRole(input: CreateRoleDto & { actorUserId: string }) {
    // Only workspace admins (MANAGE_WORKSPACE or MANAGE_ROLES) may create roles.
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: input.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_ROLES)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    const role = this.roleRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      permissions: input.permissions,
    });
    return this.roleRepo.save(role);
  }

  // ================= CHANNELS =================

  /** Creates a channel inside a workspace. Private channels restrict access to Admin and Moderator roles by default. */
  async createChannel(input: CreateChannelDto) {
    // Check actor has permission to manage channels in this workspace
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: input.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    const channelName = (input.name ?? '').trim().toLowerCase();
    if (!channelName) throw new BadRequestException('Channel name cannot be empty');
    if (channelName.length > 80)
      throw new BadRequestException('Channel name too long (max 80 characters)');

    const isPrivate = input.visibility === 'private';

    const channel = this.channelRepo.create({
      workspaceId: input.workspaceId,
      name: channelName,
      isPrivate,
      allowedUsers: isPrivate ? [input.actorUserId.trim().toLowerCase()] : [],
    });
    const savedChannel = await this.channelRepo.save(channel);

    if (isPrivate) {
      // UNWOUND ON FAILURE, exactly as `createWorkspace` unwinds a community whose distribution
      // group could not be minted. A salon marked private with no group of its own is a salon whose
      // seeds have nowhere to go, and the row would sit there looking usable.
      try {
        await this.ensureChannelDistributionGroup(savedChannel, true);
      } catch (e) {
        await this.channelRepo.delete({ id: savedChannel.id });
        this.logger.error(
          `[CHANNEL_GRAINE] private salon unwound channel=${savedChannel.id} - no distribution group: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
        throw e;
      }
    }

    // A CREATION IS A GRANT, AND EVERY OTHER GRANT HERE ANNOUNCES ITSELF. The three paths that put
    // a user into `allowedUsers` - an accepted invite, an admin join, an added member - each publish
    // this event to `channelAudience`, and each does it AFTER the grant so the newly-admitted person
    // is inside the audience rather than the one person it misses. Creation was the only grant that
    // told nobody, including the creator's own other devices.
    //
    // The consequence was not cosmetic. The only ways into a private salon's distribution group are
    // a full workspace load - post-login, the `online` event, or a deep link - and this event, so a
    // second device already running joined nothing and could not decrypt a word of the salon until
    // it was relaunched. COMM-25 measured it on 2026-08-21: the phone joined the group of all three
    // private salons that existed when it loaded its workspaces, and never heard about the one
    // created nine seconds later. A public salon has the same hole with no MLS consequence - it
    // simply did not appear for anybody until their next load.
    //
    // The audience is derived from access, so a private salon reaches its `allowedUsers` (here, the
    // creator alone, on every device they hold) and a public one reaches the whole community.
    const workspace = await this.workspaceRepo.findOne({ where: { id: savedChannel.workspaceId } });
    const audience = await this.channelAudience(savedChannel);
    await this.redis.publishChannelEvent(
      'channel.member.joined',
      {
        channelId: savedChannel.id,
        channelName: savedChannel.name,
        workspaceId: savedChannel.workspaceId,
        workspaceSlug: workspace?.slug,
        workspaceName: workspace?.name,
        visibility: savedChannel.isPrivate ? 'private' : 'public',
        joinedBy: input.actorUserId,
      },
      audience
    );

    return {
      id: savedChannel.id,
      workspaceId: savedChannel.workspaceId,
      name: savedChannel.name,
      visibility: savedChannel.isPrivate ? 'private' : 'public',
    };
  }

  /** Updates the workspace's cover image and broadcasts a workspace.updated event to all members. */
  async updateWorkspaceImage(workspaceId: string, actorUserId: string, mediaId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
      throw new ForbiddenException('Invalid mediaId format');
    }

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');

    workspace.imageMediaId = mediaId;
    await this.workspaceRepo.save(workspace);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, imageMediaId: mediaId },
      workspaceMemberIds
    );

    return { success: true, workspaceId, imageMediaId: mediaId };
  }

  /**
   * Sets what the community lets a newcomer read, and tells every member.
   *
   * **The server cannot enforce this and does not pretend to.** It holds no seed; the rule is
   * applied by whichever member answers a joiner's history request, which is why the value has to
   * be readable by every device rather than kept as one admin's local preference. Broadcasting it
   * is not a nicety either: a member still holding `shared` in memory would keep handing the past
   * over after an admin had closed it.
   */
  async updateWorkspaceHistoryVisibility(
    workspaceId: string,
    actorUserId: string,
    historyVisibility: HistoryVisibility
  ) {
    if (historyVisibility !== 'shared' && historyVisibility !== 'joined') {
      throw new BadRequestException({
        code: 'HISTORY_VISIBILITY_INVALID',
        message: `historyVisibility must be 'shared' or 'joined'`,
      });
    }

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (
      !(await this.memberHasWorkspacePermission(
        workspaceId,
        actorUserId,
        CHANNEL_PERMISSIONS.MANAGE_WORKSPACE
      ))
    ) {
      throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');
    }

    workspace.historyVisibility = historyVisibility;
    await this.workspaceRepo.save(workspace);
    // Logged at info: it changes what every future joiner may read, it is rare, and it is the only
    // trace of who opened or closed a community's past.
    this.logger.log(
      `[WORKSPACE] historyVisibility=${historyVisibility} workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
    );

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, historyVisibility },
      workspaceMemberIds
    );

    return { success: true, workspaceId, historyVisibility };
  }

  /**
   * Removes the user from the workspace and broadcasts a member-kicked event so other clients clean
   * up their UI.
   *
   * Both halves of the governance postcondition apply here: the last admin is refused until they
   * hand the role over, and the last member leaving takes the community with them.
   */
  async leaveWorkspace(workspaceId: string, userId: string) {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('Not a member of this workspace');

    await this.assertRemovalKeepsAnAdmin(workspaceId, userId);

    await this.cutOffKeyDistribution(workspaceId, userId, 'left');
    await this.cutOffEveryPrivateChannel(workspaceId, userId, 'left_workspace');

    await this.memberRepo.delete({ workspaceId, userId });

    const remainingMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    // Published before any deletion: the event is what tells the leaver's own devices to drop the
    // community, and its audience is passed explicitly rather than resolved from rows that may be
    // about to disappear.
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      { workspaceId, kickedUserId: userId, kickedBy: userId },
      [...remainingMemberIds, userId]
    );

    if (remainingMemberIds.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'last_member_left');
    }

    return { success: true };
  }

  /**
   * Deletes an entire community, for real, and broadcasts `workspace.deleted` so every member's
   * client drops it from the sidebar and purges its channels locally.
   *
   * Admin-only on purpose: unlike a kick or a channel archive, this acts on everyone at once, so
   * MANAGE_CHANNEL is deliberately NOT enough - only MANAGE_WORKSPACE.
   *
   * It used to archive instead, which kept a mistake recoverable "with two UPDATEs". That stopped
   * being true with Graine: an archived community's messages are ciphertext whose seeds no client
   * keeps, so the rows would survive as something nobody can read, invisible to every screen and
   * impossible to delete afterwards - the exact orphan shape the 2026-08-17 purge had to find by
   * hand. Recoverability that only recovers unreadable rows is not recoverability.
   *
   * `confirmationName` MUST equal the community's name, and it is checked HERE rather than only in
   * the dialog. Not defence in depth for its own sake: the fleet still holds clients built when
   * this call archived, whose confirmation was worded for a reversible action. Turning the server
   * irreversible without a new argument would make those clients destroy a community behind a
   * warning that no longer describes what happens. Requiring an argument they do not send makes
   * them fail closed, which is the only safe way for this change to meet an old client.
   */
  async deleteWorkspace(workspaceId: string, actorUserId: string, confirmationName: string) {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');

    // Checked after the permission checks on purpose: a non-admin must not be able to probe
    // whether a name matches. Trimmed on both sides because a copied name carries whitespace;
    // otherwise exact, since the whole point is having read what is about to be destroyed.
    if (confirmationName.trim() !== workspace.name.trim()) {
      this.logger.warn(
        `[WORKSPACE] delete refused, name mismatch workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
      );
      throw new BadRequestException({
        code: 'WORKSPACE_CONFIRMATION_MISMATCH',
        message: 'The confirmation does not match the community name.',
      });
    }

    // Snapshot the audience BEFORE deleting: the event has to reach every member, and the
    // membership rows the broadcast resolves against are about to be gone.
    const memberIds = await this.getWorkspaceMemberIds(workspaceId);
    const slug = workspace.slug;

    await this.hardDeleteWorkspace(workspaceId, 'admin_deleted');

    await this.redis.publishChannelEvent(
      'workspace.deleted',
      { workspaceId, deletedBy: actorUserId },
      memberIds
    );

    this.logger.log(
      `[WORKSPACE] delete workspace=${workspaceId} slug="${slug}" by=${actorUserId.slice(0, 8)} members=${memberIds.length}`
    );
    return { success: true, workspaceId };
  }

  /** Renames a channel (lowercased) and broadcasts a channel.updated event so connected clients update their sidebar. */
  async renameChannel(channelId: string, actorUserId: string, newName: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    const trimmedName = newName.trim().toLowerCase();
    if (!trimmedName) throw new BadRequestException('Channel name cannot be empty');
    if (trimmedName.length > 80)
      throw new BadRequestException('Channel name too long (max 80 characters)');

    channel.name = trimmedName;
    await this.channelRepo.save(channel);

    // The new NAME of a private salon is not the community's business.
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, name: channel.name, workspaceId: channel.workspaceId },
      audience
    );

    return { success: true, channelId, name: channel.name };
  }

  /** Returns the channel's current access settings plus the workspace's available roles. */
  async getChannelAccess(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    // `allowedUsers` IS the private salon's roster. Being in the community was enough to read it,
    // which handed its membership to people who cannot open the salon - the same question
    // `listChannelMembers` already asks one method away.
    if (!this.canAccessChannel(channel, member, actorUserId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    return {
      channelId,
      isPrivate: channel.isPrivate,
      allowedUsers: channel.allowedUsers || [],
      writePolicy: channel.writePolicy ?? 'everyone',
    };
  }

  /** Updates the channel's visibility, allowed-user list, and write policy. Requires MANAGE_CHANNEL permission. */
  async updateChannelAccess(
    channelId: string,
    actorUserId: string,
    isPrivate: boolean,
    allowedUserIds: string[],
    writePolicy?: ChannelWritePolicy
  ) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    // WHO LOSES ACCESS, COMPUTED BEFORE THE ROW CHANGES. After the save the old roster is gone, and
    // a member dropped from a private salon would keep being routed its seeds with nothing left
    // anywhere to say they should not be.
    const wasPrivate = channel.isPrivate;
    const previousAllowed = new Set(channel.allowedUsers || []);
    const nextAllowed = isPrivate ? allowedUserIds.map((u) => u.trim().toLowerCase()) : [];
    // ONLY WHILE IT STAYS PRIVATE. A salon going public loses its group entirely a few lines below,
    // and that retirement supersedes every per-user cut - evicting people who are about to regain
    // access as ordinary community members would be work with no reader.
    const dropped =
      wasPrivate && isPrivate ? [...previousAllowed].filter((u) => !nextAllowed.includes(u)) : [];

    // BEFORE THE SAVE, and allowed to abort it - the same asymmetry as a community departure. Going
    // private without a group would leave the salon's seeds nowhere to go; cutting someone off
    // after the row already says they are out is a routing row nothing comes back for.
    if (isPrivate && !wasPrivate) await this.ensureChannelDistributionGroup(channel, isPrivate);
    for (const userId of dropped) {
      await this.cutOffChannelKeyDistribution(channel, userId, 'access_updated');
    }

    channel.isPrivate = isPrivate;
    channel.allowedUsers = nextAllowed;
    if (writePolicy) {
      channel.writePolicy = writePolicy;
    }
    await this.channelRepo.save(channel);

    // AFTER the save, and best-effort: the salon is public now, so its own group distributes to a
    // roster nothing consults - inert if it survives, and refusing the change over it would be
    // worse. The community's group takes over from here.
    if (!isPrivate && wasPrivate) await this.retireChannelDistributionGroup(channel, 'made_public');

    // THE RULE CHANGED FOR PEOPLE WHO ARE ALREADY LOOKING AT THE SALON, and until 2026-08-20 they
    // learned of it only on their next full load: COMM-7 found a member still holding a composer in
    // a salon that had just been reserved for administrators, typing into it and collecting a 403.
    // The server refusing correctly is half a rule - the other half is the person being told.
    //
    // THE DECISION TRAVELS, NEVER THE POLICY, so the audience is SPLIT BY THE ANSWER and each half
    // is sent its own: one payload cannot carry a per-viewer verdict, and a client holds none of the
    // roles it would need to derive one. Two publishes at most, whatever the community's size.
    const audience = await this.channelAudience(channel);
    const decisions = await this.writeDecisionsFor(channel, audience);
    for (const mayWrite of [true, false]) {
      const half = audience.filter((u) => (decisions.get(u) ?? true) === mayWrite);
      if (half.length === 0) continue;
      await this.redis.publishChannelEvent(
        'channel.updated',
        {
          channelId,
          workspaceId: channel.workspaceId,
          isPrivate: channel.isPrivate,
          viewerCanWrite: mayWrite,
        },
        half
      );
    }
    this.logger.log(
      `[CHANNEL] access updated channel=${channelId} private=${channel.isPrivate} ` +
        `writePolicy=${channel.writePolicy ?? 'everyone'} audience=${audience.length} ` +
        `mayWrite=${[...decisions.values()].filter(Boolean).length}`
    );

    return {
      ok: true,
      channelId,
      isPrivate: channel.isPrivate,
      allowedUsers: channel.allowedUsers,
      writePolicy: channel.writePolicy,
    };
  }

  /**
   * Deletes a salon, for real - its row, its messages and its key-distribution group.
   *
   * IT USED TO ARCHIVE, which was the community's own defect one scope down. `archived = true` hid
   * the salon from every listing while the same call destroyed the group holding its seeds, so a
   * private salon's messages survived as ciphertext no client on earth could open: invisible to
   * every screen, unreachable by every route, and removable only by deleting the whole community.
   * Nothing could bring it back either - there is no un-archive anywhere in this service, and never
   * was. The reasoning is {@link deleteWorkspace}'s, unchanged one level down: recoverability that
   * only recovers unreadable rows is not recoverability.
   *
   * NO CONFIRMATION ARGUMENT, and the asymmetry with `deleteWorkspace` is a measurement rather than
   * an oversight. That call needed one because the fleet held clients whose dialog described a
   * REVERSIBLE action, and making the server irreversible behind that wording would have destroyed
   * a community behind a warning that no longer described it. This dialog has read "Supprimer
   * definitivement le canal #x ?" since 2026-06-16, which is the first version of the string that
   * ever shipped: every client in the field already promises exactly what this now does, so there
   * is nothing to fail closed against and an argument would only break them for no gain.
   *
   * MANAGE_CHANNEL is enough here where the community demands MANAGE_WORKSPACE. A salon is one room
   * and governing rooms is what that permission IS; deleting a community acts on everyone at once.
   */
  async deleteChannel(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    // Snapshot the audience BEFORE anything goes. `channelAudience` reads the salon's own roster off
    // the row this is about to delete, so afterwards there is nobody left to address the event to -
    // the same reason `deleteWorkspace` takes its member ids first.
    const audience = await this.channelAudience(channel);
    const workspaceId = channel.workspaceId;

    // BEFORE the transaction, and allowed to ABORT it - the one line separating this from the
    // archive it replaces. `retireChannelDistributionGroup` swallows its failure deliberately: there
    // the salon survives, so a group outliving its retirement is inert and refusing the change would
    // be worse. Here the row is about to be gone, and a group nothing names any more is exactly the
    // orphan the 2026-08-17 purge had to find by hand. Failing here leaves the salon whole and the
    // deletion retryable, which is the only outcome that stays reconcilable.
    if (channel.distributionGroupId) {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
    }

    // Named by hand for the reason `hardDeleteWorkspace` gives: there is not one foreign key on
    // `channels`, so nothing cascades and nothing would complain if a table were forgotten.
    // `channel_messages` is the only one keyed by channel - checked, not assumed.
    await this.channelRepo.manager.transaction(async (mgr) => {
      await mgr.delete(ChannelMessage, { channelId });
      await mgr.delete(Channel, { id: channelId });
    });

    await this.redis.publishChannelEvent('channel.deleted', { channelId, workspaceId }, audience);

    this.logger.log(
      `[CHANNEL] delete channel=${channelId} workspace=${workspaceId} ` +
        `private=${channel.isPrivate} group=${channel.distributionGroupId ?? 'none'} ` +
        `by=${actorUserId.slice(0, 8)} audience=${audience.length}`
    );

    return { success: true };
  }

  /**
   * Lists the channels a user may see in a workspace.
   *
   * MAY SEE, not may read, and the two stopped being the same thing on 2026-08-19: an
   * administrator is shown a private salon they have not joined - its name, its `viewerHasAccess:
   * false`, and nothing else. Every other route still refuses them its messages, its roster and its
   * seeds, because all of those go through `canAccessChannel`, which says no until they join.
   *
   * The row exists so the join is REACHABLE. Without it, making the admin bypass explicit would
   * have made private salons invisible to the only people who can moderate them - and what leaks
   * is a salon's existence, to someone who can add themselves to it in one click anyway.
   *
   * The same projection as `getWorkspaceBySlug` and deliberately so: two lists of the same channels
   * differing in one field is a client that renders a salon one way through the sidebar and another
   * through the community page.
   */
  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const viewerCanManage = await this.memberHasWorkspaceManage(member);
    const channels = await this.channelRepo.find({ where: { workspaceId } });
    const visible: Array<{
      id: string;
      workspaceId: string;
      name: string;
      visibility: 'public' | 'private';
      viewerHasAccess: boolean;
    }> = [];
    for (const channel of channels) {
      const hasAccess = this.canAccessChannel(channel, member, userId);
      if (!hasAccess && !viewerCanManage) continue;
      visible.push({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        visibility: channel.isPrivate ? 'private' : 'public',
        viewerHasAccess: hasAccess,
      });
    }
    return visible;
  }

  /** True when the member holds a role carrying MANAGE_WORKSPACE. */
  private async memberHasWorkspaceManage(member: ChannelMember): Promise<boolean> {
    if (!member.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
  }

  /** Adds a user to a workspace channel. Creates the workspace membership with the default Member role if this is their first channel in the workspace. */
  async joinChannel(channelId: string, input: ChannelJoinDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });

    let member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    const isNewMember = !member;

    if (!member) {
      const defaultRole = await this.roleRepo.findOne({
        where: { workspaceId: channel.workspaceId, name: 'Member' },
      });
      member = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.userId,
        roleIds: defaultRole ? [defaultRole.id] : [],
      });
      await this.memberRepo.save(member);
    }

    // Publish event to notify connected clients. The payload names the salon, so it goes to the
    // people who may see that salon - plus the joiner, who is told about their own arrival whether
    // or not this channel turns out to be one they can read.
    if (isNewMember) {
      const audience = await this.channelAudience(channel);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId,
          channelName: channel.name,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          visibility: channel.isPrivate ? 'private' : 'public',
          roleName: input.roleName || 'Member',
          joinedBy: input.userId,
        },
        [...new Set([...audience, input.userId])]
      );
    }

    return { success: true };
  }

  /**
   * Whether the user has an active MLS device registered in chat-delivery.
   *
   * FAILS CLOSED, since 2026-08-19. It used to answer `true` on a non-2xx AND on any thrown error
   * AND on an unset secret, so the day its URL was missing the `/api` prefix it was a constant
   * `true` - a guard nobody had, for as long as nobody looked. Now it answers only what a genuine
   * 200 said, and anything else throws out of `fetchUserDeviceCount`.
   *
   * @throws ServiceUnavailableException when the question could not be asked
   */
  private async userHasMlsDevices(userId: string): Promise<boolean> {
    return (await fetchUserDeviceCount(this.internalSecret, userId)) > 0;
  }

  /**
   * Invites a user to a channel: makes them a member of the community if they are not one yet, and
   * for a private channel adds them to `allowedUsers`.
   *
   * It hands back NO key material, and cannot: a channel message is sealed under a Graine session
   * whose seed only its sender's devices hold. What the invitee reads of the past is decided by
   * `historyVisibility` and answered by another member over the distribution group, never here.
   */
  async inviteToChannel(channelId: string, input: ChannelInviteDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });

    // Check if actor has permission to invite
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.INVITE_MEMBERS) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing INVITE_USERS permission');

    // Reject early if the invitee has no MLS device - the key DM could never be delivered.
    //
    // TWO OUTCOMES, TWO ANSWERS. This throws `ServiceUnavailableException` when it could not ask,
    // which is deliberately NOT this branch: "this person has not installed Canari" is advice about
    // them, and "the key service cannot be reached" is a retry about us. Rounding the second into
    // the first is what the old fail-open version did in reverse, and it told the inviter their
    // invitation had gone through.
    const hasDevices = await this.userHasMlsDevices(input.targetUserId);
    if (!hasDevices) {
      throw new BadRequestException({
        code: 'USER_HAS_NO_DEVICE',
        message: `User ${input.targetUserId} has not yet set up Canari on any device.`,
      });
    }

    // Add target user as member if not already
    let targetMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.targetUserId },
    });

    const isNewMember = !targetMember;

    if (!targetMember) {
      // Find the role to assign (default to Member if not specified)
      const roleName = this.mapRoleInputToWorkspaceRoleName(input.roleName || 'Membre');
      const role = await this.roleRepo.findOne({
        where: { workspaceId: channel.workspaceId, name: roleName },
      });
      const roleIds = role ? [role.id] : [];

      targetMember = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.targetUserId,
        roleIds,
      });
      await this.memberRepo.save(targetMember);
    }

    if (isNewMember) {
      // ACCESS IS GRANTED BEFORE IT IS ANNOUNCED, and the order is the whole point: the audience of
      // the announcement is derived from `allowedUsers`, so granting afterwards would address the
      // invitation to everyone EXCEPT the person invited. For private channels with user-based
      // access this is the only row change left, so the save belongs to this branch alone.
      if (channel.isPrivate) {
        const existing = channel.allowedUsers || [];
        const normalized = input.targetUserId.trim().toLowerCase();
        if (!existing.includes(normalized)) {
          channel.allowedUsers = [...existing, normalized];
          await this.channelRepo.save(channel);
        }
      }

      // Publish event to notify the invited user and connected clients
      const audience = await this.channelAudience(channel);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId,
          channelName: channel.name,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          visibility: channel.isPrivate ? 'private' : 'public',
          roleName: this.mapRoleInputToWorkspaceRoleName(input.roleName || 'Membre'),
          joinedBy: input.targetUserId,
          invitedBy: input.actorUserId,
        },
        audience
      );
    }

    return {
      success: true,
      userId: input.targetUserId,
      alreadyMember: !isNewMember,
    };
  }

  /**
   * Removes the calling user from a PRIVATE channel.
   *
   * Only a private channel can be left, because only a private channel holds per-user access
   * (`allowedUsers`). A public one is readable by every member of the community and has no row
   * naming the leaver, so there is nothing here to remove and the honest answer is a refusal:
   * this used to delete their COMMUNITY membership instead, which put them outside a community
   * their client still displayed - and every workspace-scoped call, "leave the community"
   * included, then answered 404. Leaving a community is `leaveWorkspace`, and a channel-scoped
   * operation may not stand in for it. See `removeMemberFromChannel` for the same rule applied to
   * the admin-side removal.
   */
  async leaveChannel(channelId: string, input: ChannelLeaveDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    if (!member) throw new NotFoundException('Member not found');

    if (!channel.isPrivate) {
      this.logger.debug(
        `[CHANNEL] refused leave of public channel=${channelId} by=${input.userId.slice(0, 8)}`
      );
      throw new BadRequestException(
        'A public channel is readable by every member of the community and cannot be left on its own. Leave the community instead.'
      );
    }

    // BEFORE the roster is written, and allowed to abort the departure - the same asymmetry as a
    // community's. Once `allowedUsers` no longer names them, nothing left anywhere would ever go
    // looking for their routing rows again.
    await this.cutOffChannelKeyDistribution(channel, input.userId, 'left_channel');

    // Access is the only thing this revokes. Nothing here rotates a key: a channel message is
    // sealed under a Graine session, and what shuts the leaver out is the senders minting a fresh
    // session on the next send - which they do because a departure is what rotates a Graine.
    const normalized = input.userId.trim().toLowerCase();
    channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalized);
    await this.channelRepo.save(channel);

    return { success: true };
  }

  /** Kicks a member from the workspace entirely (removes from all channels). Requires MANAGE_WORKSPACE, MANAGE_CHANNEL, or KICK_MEMBERS permission. */
  async kickFromWorkspace(workspaceId: string, targetUserId: string, actorUserId: string) {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.KICK_MEMBERS)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL or KICK_MEMBERS permission');

    // Verify the target user is a member
    const targetMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Target member not found in workspace');

    // The actor's permission was checked; the TARGET's roles never were, so KICK_MEMBERS alone
    // used to remove the sole Administrateur.
    await this.assertRemovalKeepsAnAdmin(workspaceId, targetUserId);

    await this.cutOffKeyDistribution(workspaceId, targetUserId, 'kicked');
    await this.cutOffEveryPrivateChannel(workspaceId, targetUserId, 'kicked_from_workspace');

    await this.memberRepo.delete({ workspaceId, userId: targetUserId });

    // Notify the kicked user and remaining workspace members
    const remainingMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    const notifyIds = [...new Set([...remainingMemberIds, targetUserId])];
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      {
        workspaceId,
        kickedUserId: targetUserId,
        kickedBy: actorUserId,
      },
      notifyIds
    );

    this.logger.log(
      `[WORKSPACE] kick workspace=${workspaceId} target=${targetUserId.slice(0, 8)} by=${actorUserId.slice(0, 8)}`
    );

    // An admin removing themselves as the last member is the same disappearance as leaving, and
    // gets the same answer rather than a community nobody belongs to.
    if (remainingMemberIds.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'last_member_kicked');
    }

    return { success: true };
  }

  /**
   * Replaces a workspace member's roleIds with the single specified role (removes all existing
   * roles). Roles are a workspace-level concept, so this is keyed by workspaceId directly.
   * Requires the actor to hold MANAGE_WORKSPACE or MANAGE_ROLES in the workspace.
   */
  async updateWorkspaceMemberRole(
    workspaceId: string,
    targetUserId: string,
    roleName: string,
    actorUserId: string
  ) {
    const adminMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!adminMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (adminMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(adminMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_ROLES)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    const targetMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Target member not found');

    const role = await this.roleRepo.findOne({
      where: {
        workspaceId,
        name: this.mapRoleInputToWorkspaceRoleName(roleName),
      },
    });
    if (!role) throw new NotFoundException('Role not found');

    // A demotion is an exit from the admin set, so it faces the same postcondition as a departure.
    // MANAGE_ROLES alone used to be enough to strip the last Administrateur - including oneself -
    // after which nothing inside the community could grant the role back. There is always at least
    // one member here (the target), so the "no members" escape never applies.
    if (!role.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)) {
      const adminIds = await this.listWorkspaceAdminIds(workspaceId);
      if (adminIds.length === 1 && adminIds[0] === targetUserId) {
        this.logger.warn(
          `[WORKSPACE] refused demotion of the last admin workspace=${workspaceId} target=${targetUserId.slice(0, 8)} by=${actorUserId.slice(0, 8)}`
        );
        throw new BadRequestException({
          code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
          message: 'The community would be left with no administrator.',
        });
      }
    }

    // Replace all existing roles with the single specified role.
    targetMember.roleIds = [role.id];
    await this.memberRepo.save(targetMember);

    this.logger.log(
      `[WORKSPACE] role set workspace=${workspaceId} target=${targetUserId.slice(0, 8)} role="${role.name}" by=${actorUserId.slice(0, 8)}`
    );

    // TOLD TO THE PERSON IT IS ABOUT, and only to them.
    //
    // Measured on production 2026-08-20 (COMM-5): a role change reached the other device NEVER -
    // the promoted member could not moderate, and, the direction that matters, a DEMOTED
    // administrator went on being offered every control they had just lost for as long as their tab
    // stayed open. Nothing was breakable, because the server re-checks each of those actions; what
    // the person got was a screen full of buttons that now fail with no explanation.
    //
    // THE PERMISSIONS TRAVEL WITH THE EVENT rather than being fetched back. The client caches
    // exactly one permission-derived flag today (`viewerCanManage`), and it is DERIVED FROM THIS
    // ROLE, which is known here - so handing it over is the discriminator carried to where the
    // decision is made, instead of a round trip that can fail, race a load already in flight, or
    // arrive after the user has clicked. The whole permission list is sent, not just the one flag,
    // so the day the client caches a second one there is nothing to change on this side.
    //
    // Best-effort and logged: a member who misses this is exactly where they were before it
    // existed - correct on their next load - so a failed publish must not undo a role change that
    // has already been written.
    try {
      await this.redis.publishChannelEvent(
        'workspace.role.changed',
        {
          workspaceId,
          userId: targetUserId,
          roleName: role.name,
          permissions: role.permissions,
          canManage: role.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE),
          changedBy: actorUserId,
        },
        [targetUserId]
      );
    } catch (e) {
      this.logger.warn(
        `[WORKSPACE] role set but not announced workspace=${workspaceId} target=${targetUserId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    return { success: true };
  }

  /** Channel-scoped shim for {@link updateWorkspaceMemberRole}, kept for the legacy channel-members route. */
  async updateMemberRole(channelId: string, input: ChannelUpdateRoleDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    return this.updateWorkspaceMemberRole(
      channel.workspaceId,
      input.targetUserId,
      input.roleName,
      input.actorUserId
    );
  }

  /** Removes a user from a specific channel without removing them from the workspace.
   *  For private channels, removes them from allowedUsers and rotates the key.
   *  For public channels, only rotates the key so the removed user's cached epoch key
   *  is invalidated (the user is still a workspace member and can re-join if invited again).
   *  Requires MANAGE_WORKSPACE or MANAGE_CHANNELS permission. */
  async removeMemberFromChannel(channelId: string, targetUserId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const adminMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!adminMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (adminMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(adminMember.roleIds) } });
      hasPerm = roles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.KICK_MEMBERS)
      );
    }

    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL or KICK_MEMBERS permission');

    // Verify the target user is a workspace member
    const targetMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Target member not found in workspace');

    // Remove from private channel's allowedUsers list
    if (channel.isPrivate) {
      // The cut goes first and may abort the removal: after the save there is no row left naming
      // this person for the salon, so a routing row surviving the failure would be unfindable.
      await this.cutOffChannelKeyDistribution(channel, targetUserId, 'removed_from_channel');
      const normalized = targetUserId.trim().toLowerCase();
      channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalized);
      await this.channelRepo.save(channel);
    }

    // Notify the removed user and everyone who can still see the salon. `allowedUsers` was
    // stripped just above, so the target is no longer in the audience and is added back by name -
    // losing access is the one event its subject must receive.
    const audience = await this.channelAudience(channel);
    const notifyIds = [...new Set([...audience, targetUserId])];
    await this.redis.publishChannelEvent(
      'channel.member.removed',
      {
        channelId,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        removedUserId: targetUserId,
        removedBy: actorUserId,
        // See kickMember: only a private channel is actually lost by the target.
        isPrivate: channel.isPrivate,
      },
      notifyIds
    );

    // No key is rotated here, and none can be: the seed that opens this channel's messages lives on
    // the sending devices. Removing someone from the community makes them ineligible for the
    // distribution group, and every sender mints a fresh session on the next send.
    return { success: true };
  }

  // ================= CHANNEL MEMBERS =================

  /**
   * Lists members with their highest-priority role normalized to admin/moderator/member.
   *
   * `scope: 'channel'` (default) answers "who is in THIS channel": for a private channel that is
   * its allowed users plus the workspace admins, not the whole community. `scope: 'workspace'` is
   * the community roster - what the settings panel needs, since the picker that grants access to a
   * private channel must be able to offer people who are not in it yet.
   */
  async listChannelMembers(
    channelId: string,
    actorUserId: string,
    scope: 'channel' | 'workspace' = 'channel'
  ) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');
    if (scope === 'channel' && !this.canAccessChannel(channel, actorMember, actorUserId)) {
      throw new ForbiddenException('Not allowed to read this channel');
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    // A private channel has its own roster: returning the workspace's listed people who cannot
    // read the channel at all. Mirrors canAccessChannel (explicit allowedUsers, plus anyone
    // holding workspace.manage) but resolved from the roles already loaded above, so scoping the
    // list costs no extra query.
    const allowedUsers = new Set((channel.allowedUsers || []).map((u) => u.trim().toLowerCase()));
    const belongsToChannel = (member: ChannelMember): boolean => {
      if (scope === 'workspace' || !channel.isPrivate) return true;
      if (allowedUsers.has(member.userId.trim().toLowerCase())) return true;
      return (member.roleIds || []).some((roleId) =>
        roleMap.get(roleId)?.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
      );
    };

    return members.filter(belongsToChannel).map((m) => {
      const memberRoles = (m.roleIds || []).map((rid) => roleMap.get(rid)).filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: this.normalizeRoleLabelToCanonical(highestRole?.name),
        joinedAt: m.createdAt,
      };
    });
  }

  /**
   * The community's roster, keyed by the COMMUNITY.
   *
   * `listChannelMembers(..., 'workspace')` answers the same question through a channel id, which
   * every caller that has one should keep using. This one exists for the caller that has none: a
   * device that has just joined a community's Graine distribution group and needs to name who to
   * ask for history, before any salon has been opened. Reaching for an arbitrary channel to get a
   * community's roster is the kind of indirection that breaks the first time the list is empty.
   */
  async listWorkspaceMembers(workspaceId: string, actorUserId: string) {
    await this.assertWorkspaceMember(workspaceId, actorUserId);

    const members = await this.memberRepo.find({ where: { workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    return members.map((m) => {
      const memberRoles = (m.roleIds || []).map((rid) => roleMap.get(rid)).filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: this.normalizeRoleLabelToCanonical(highestRole?.name),
        joinedAt: m.createdAt,
      };
    });
  }

  // ================= MESSAGES =================

  /**
   * WHETHER A POLL IS OVER, decided with the clock that wrote the deadline.
   *
   * `endsAt` is an instant on THIS clock, so this is the only side entitled to compare it. Every
   * consumer asks here - the vote refusal, the close refusal, the opportunistic auto-unpin, and what
   * a client is served - so a poll cannot be closed for one of them and open for another.
   */
  private pollIsOver(meta: Pick<ChannelPollMeta, 'endsAt'>): boolean {
    return !!meta.endsAt && new Date(meta.endsAt).getTime() <= Date.now();
  }

  /**
   * A poll as a client is told it: {@link ServedChannelPollMeta}, stamped with {@link pollIsOver}.
   *
   * Every route that hands a poll out goes through here, because the alternative is a client
   * re-deriving closedness from `endsAt` against its own clock - which is the defect this stamp
   * exists to remove (see the DTO for what that cost).
   */
  private servedPoll(meta: ChannelPollMeta | null | undefined): ServedChannelPollMeta | null {
    if (!meta) return null;
    return { ...meta, closed: this.pollIsOver(meta) };
  }

  /**
   * Validates a poll descriptor and returns the initial server-side poll state.
   * Rejects fewer than 2 options, duplicate IDs, or a deadline already in the past.
   */
  private buildPollMeta(input: NonNullable<SendChannelMessageDto['poll']>): ChannelPollMeta {
    const optionIds = Array.isArray(input.optionIds) ? input.optionIds : [];
    if (optionIds.length < 2) {
      throw new BadRequestException('A poll needs at least 2 options');
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new BadRequestException('Poll option IDs must be unique');
    }
    let endsAt: string | null = null;
    if (input.endsAt) {
      const ts = new Date(input.endsAt).getTime();
      if (Number.isNaN(ts)) throw new BadRequestException('Invalid poll endsAt');
      if (ts <= Date.now()) throw new BadRequestException('Poll deadline must be in the future');
      endsAt = new Date(ts).toISOString();
    }
    return {
      optionIds,
      multipleChoice: input.multipleChoice === true,
      endsAt,
      votesByUser: {},
    };
  }

  /**
   * Persists a client-encrypted message, then publishes the ciphertext to every workspace member
   * over Redis. The server validates that the row NAMES a Graine session and an index - never that
   * it can open it, which it cannot.
   */
  async sendMessage(channelId: string, input: SendChannelMessageDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.senderId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, input.senderId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    // Read access is not enough: the channel's writePolicy may restrict posting
    // (e.g. an announcements channel where only admins/moderators can write).
    if (!(await this.canWriteToChannel(channel, input.senderId))) {
      throw new ForbiddenException('Not allowed to post in this channel');
    }
    // A message names the Graine session that opens it, and which key of that session. The server
    // holds no seed and can supply neither, so a message missing one is a message NOBODY can ever
    // read - it is refused here rather than stored as an unreadable row that looks like history.
    //
    // There is no "stale" refusal any more, and that is the point: `STALE_CHANNEL_KEY_VERSION`
    // existed because the server derived the key and knew which epoch was current. It knows
    // nothing about a Graine session but its name, so a sender can never be behind it.
    if (typeof input.senderSessionId !== 'string' || input.senderSessionId.length === 0) {
      throw new BadRequestException({
        code: 'CHANNEL_SESSION_REQUIRED',
        message: 'senderSessionId is required for channel messages',
      });
    }
    if (!Number.isInteger(input.messageIndex) || input.messageIndex < 0) {
      throw new BadRequestException({
        code: 'CHANNEL_MESSAGE_INDEX_REQUIRED',
        message: 'messageIndex must be a non-negative integer',
      });
    }

    // A poll is just an encrypted message carrying a label-free descriptor: we
    // store its option IDs/deadline server-side (for tallying + auto-pin) while
    // the question and labels stay in the ciphertext. Auto-pinned so it stays
    // reachable via the channel's pin list instead of drowning in the feed.
    const pollMeta = input.poll ? this.buildPollMeta(input.poll) : null;

    const msg = this.messageRepo.create({
      // Never use a client-supplied ID as the DB primary key - the server
      // always generates a fresh UUID to prevent IDOR / row-overwrite attacks.
      workspaceId: channel.workspaceId,
      channelId,
      authorId: input.senderId,
      content: input.ciphertext,
      nonce: input.nonce,
      senderSessionId: input.senderSessionId,
      messageIndex: input.messageIndex,
      silent: input.silent === true,
      metadata: pollMeta ? { poll: pollMeta } : {},
      pinned: pollMeta !== null,
    });

    const savedMsg = await this.messageRepo.save(msg);
    if (pollMeta) {
      this.logger.log(
        `[POLL] created channel=${channelId} message=${savedMsg.id} options=${pollMeta.optionIds.length} endsAt=${pollMeta.endsAt ?? 'none'}`
      );
    }

    // Publish event fire-and-forget - do not block the HTTP response. Addressed to the people who
    // may READ the salon: this frame carries the ciphertext inline, and a private channel's
    // audience is not its community's.
    this.channelAudience(channel)
      .then((audience) =>
        this.redis.publishChannelEvent(
          'channel.message.created',
          {
            channelId,
            messageId: savedMsg.id,
            senderId: input.senderId,
            ciphertext: input.ciphertext,
            nonce: input.nonce,
            senderSessionId: input.senderSessionId,
            messageIndex: input.messageIndex,
            createdAt: savedMsg.createdAt,
            silent: savedMsg.silent,
            // Poll descriptor (no labels) so peers render the card live without refetch.
            poll: this.servedPoll(pollMeta),
            pinned: savedMsg.pinned,
          },
          audience
        )
      )
      .catch((err) => this.logger.error(`Failed to publish channel message event: ${err}`));

    // Fan out push notifications to offline/background members, honouring each member's
    // per-channel level. Fire-and-forget: never block the HTTP response on FCM.
    //
    // A SILENT row rings nobody. A reaction that pushed would make every heart a notification, and
    // a community where that happens is a community people mute. The author is still told, by the
    // client, through the same targeted push a DM reaction uses.
    if (!savedMsg.silent) {
      this.notifyChannelRecipients(channel, savedMsg, input).catch((err) =>
        this.logger.error(`[CHANNEL_PUSH] fan-out failed channel=${channelId}: ${err}`)
      );
    }

    return savedMsg;
  }

  /**
   * Sends a push notification for a new channel message to every workspace member who should
   * receive one, according to their per-channel notification level:
   *  - `none`  -> never;
   *  - `mentions` -> only if the member is in `input.mentionedUserIds`;
   *  - `all` (default) -> always.
   * The sender is always skipped, as are members who cannot access the channel. The server holds
   * the channel key but never decrypts here: the ciphertext travels inline so the device decrypts
   * it locally (Google/FCM never sees the plaintext), mirroring the MLS DM push path.
   *
   * `mentioned` is computed per recipient and is the ONE fact only this side knows: the MLS path
   * has to scan the decrypted text for `@[<uuid>]` because the server cannot read it, whereas a
   * channel message carries a cleartext `mentionedUserIds` from the sender. So the device is TOLD
   * rather than left to infer - which is also the only answer that survives a push whose ciphertext
   * was too large to inline, where there is no text to scan.
   */
  private async notifyChannelRecipients(
    channel: Channel,
    message: ChannelMessage,
    input: SendChannelMessageDto
  ): Promise<void> {
    if (!this.internalSecret) {
      this.logger.warn('[CHANNEL_PUSH] INTERNAL_SECRET not set - channel push disabled');
      return;
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const mentioned = new Set((input.mentionedUserIds ?? []).map((id) => id.trim().toLowerCase()));

    // FCM caps a data payload at ~4 KB; inline the ciphertext only when it comfortably fits,
    // otherwise the notification degrades to the generic "new message in #channel" body until the
    // app opens and fetches the channel over HTTP. nonce stays inline (small).
    const inlineCiphertext = input.ciphertext.length <= 3000 ? input.ciphertext : '';

    // Same audience as the live event, from the same function - a push that reached somebody the
    // WebSocket frame did not would be the leak this scoping exists to close, arriving by another
    // door. It also replaces one permission query PER MEMBER with the two `channelAudience` does.
    const audience = new Set(await this.channelAudience(channel));

    const recipients: ChannelMember[] = [];
    for (const member of members) {
      if (member.userId === input.senderId) continue;
      if (!audience.has(member.userId)) continue;
      const level: ChannelNotificationLevel = member.notifLevels?.[channel.id] ?? 'all';
      if (level === 'none') continue;
      if (level === 'mentions' && !mentioned.has(member.userId.trim().toLowerCase())) continue;
      recipients.push(member);
    }

    if (recipients.length === 0) return;
    this.logger.log(
      `[CHANNEL_PUSH] channel=${channel.id} message=${message.id} recipients=${recipients.length}`
    );

    // The community NAME, resolved here because nothing downstream can: `workspaceId` is a uuid and
    // no native surface holds a workspace mirror the way `channel_keys.json` mirrors the keys.
    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });
    if (!workspace) {
      // A channel whose workspace row is gone is a data-integrity fault, not a normal path. The
      // notification degrades to the salon alone rather than being dropped, and this line is the
      // only thing that says the community was lost rather than never asked for.
      this.logger.error(
        `[CHANNEL_PUSH] workspace=${channel.workspaceId} not found for channel=${channel.id} - title degrades to the salon alone`
      );
    }
    const workspaceName = workspace?.name ?? '';

    // EVERY FIELD HERE IS READ BY A CLIENT. Three others used to travel with it and were read by
    // none of the three (measured 2026-08-15), so they were dropped rather than left to look like a
    // contract:
    //  - `workspaceId` was a uuid nobody could render; `workspaceName` replaces it because it is
    //    what the title actually needs.
    //  - `messageId` / `createdAt` cannot repeat what the MLS path does with them. That path writes
    //    `fcm_message_cache.ndjson` so a background-decrypted message is already in the local store
    //    at open; a channel message is DELIBERATELY never persisted locally (`useMessaging` skips
    //    the DB save for a `channel_` conversation - channels are server-authoritative and refetched
    //    over HTTP), so the cache has nowhere to inject.
    // Fewer bytes on the wire also buys headroom under the same 4 KB cap the ciphertext competes for.
    const data: Record<string, string> = {
      type: 'channel',
      channelId: channel.id,
      channelName: channel.name,
      workspaceName,
      // The session and the index, because they are what derives the key now. `keyVersion` used to
      // sit here and named an epoch the server derived; nothing on any device can do anything with
      // it any more, so it is gone rather than left looking like a contract.
      senderSessionId: input.senderSessionId,
      messageIndex: String(input.messageIndex),
      ciphertext: inlineCiphertext,
      nonce: input.nonce,
      senderId: input.senderId,
    };

    const title = this.buildChannelPushTitle(workspaceName, channel.name);
    await Promise.all(
      recipients.map((member) =>
        this.sendInternalPush(member.userId, title, {
          ...data,
          mentioned: mentioned.has(member.userId.trim().toLowerCase()) ? 'true' : 'false',
        })
      )
    );
  }

  /**
   * Records that `userId` has read `channelId` and fans out a silent `channel_read` push to that
   * user's own devices so any device still showing the channel's notification clears it (cross-device
   * read-state sync). The reading device ignores it (foreground guard); sibling devices in the
   * background cancel the notification. Access-controlled: the caller must be able to see the channel.
   */
  async markChannelRead(channelId: string, userId: string): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    if (!this.internalSecret) return;
    await this.sendInternalPush(userId, channel.name, {
      type: 'channel_read',
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      senderId: userId,
    });
  }

  /**
   * The title of a salon notification: `<Communaute> - #<salon>`.
   *
   * FOUR SURFACES SPELL THIS FORMAT, one per process that can put the banner on a screen: this one
   * (the APNs alert title, which is what an iPhone shows when the Notification Service Extension
   * cannot run), the Kotlin FCM service, that extension, and the app-alive `canari_push.mm`. No
   * compiler spans them, so `channelPushFields.test.ts` asserts the separator on all four.
   *
   * The community DEGRADES away rather than erroring: an unnamed workspace still yields `#<salon>`,
   * which is exactly what the title was before this field existed.
   */
  private buildChannelPushTitle(workspaceName: string, channelName: string): string {
    return workspaceName ? `${workspaceName} - #${channelName}` : `#${channelName}`;
  }

  /**
   * Posts a single user's push to chat-delivery's internal endpoint (where Firebase Admin lives).
   * Best-effort: a failed push must never surface to the message sender.
   */
  private async sendInternalPush(
    userId: string,
    title: string,
    data: Record<string, string>
  ): Promise<void> {
    try {
      const res = await fetch(deliveryUrl('internal/push/notify'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.internalSecret,
        },
        // body left empty: the device composes the visible text after decrypting the ciphertext.
        body: JSON.stringify({ userId, title, body: '', data }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`[CHANNEL_PUSH] notify HTTP ${res.status} for user=${userId}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      this.logger.warn(`[CHANNEL_PUSH] notify failed for user=${userId}: ${msg}`);
    }
  }

  /**
   * Sets the calling member's notification level for one channel. Validates that the user is a
   * workspace member and can access the channel. Storing `all` keeps the map explicit (it is the
   * default when absent, but an explicit entry lets the client show the chosen value).
   */
  async setNotificationLevel(
    channelId: string,
    userId: string,
    level: ChannelNotificationLevel
  ): Promise<{ channelId: string; level: ChannelNotificationLevel }> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    // Use the DB-canonical `channel.id` (loaded above) rather than the raw request
    // param as the map key, so a remote-controlled value never becomes an object
    // property name (remote property injection, CWE-250/915).
    member.notifLevels = { ...member.notifLevels, [channel.id]: level };
    await this.memberRepo.save(member);
    this.logger.log(`[CHANNEL_PUSH] level set channel=${channelId} user=${userId} level=${level}`);
    return { channelId, level };
  }

  /** Returns the calling member's notification level for one channel (`all` when never set). */
  async getNotificationLevel(
    channelId: string,
    userId: string
  ): Promise<{ channelId: string; level: ChannelNotificationLevel }> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const level: ChannelNotificationLevel = member.notifLevels?.[channel.id] ?? 'all';
    return { channelId, level };
  }

  /**
   * Broadcasts an ephemeral typing signal to the channel's workspace members.
   * Not persisted and best-effort: a failure to publish is non-critical.
   */
  async publishTyping(channelId: string, userId: string, isTyping: boolean): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.typing',
      { channelId, userId, state: isTyping ? 'start' : 'stop' },
      audience
    );
  }

  /** Pins/unpins a channel message and broadcasts a `channel.pin` event to workspace members. */
  async setMessagePinned(
    channelId: string,
    messageId: string,
    userId: string,
    pinned: boolean
  ): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId, channelId } });
    if (!msg) throw new NotFoundException('Message not found');

    // Pinning someone else's message is a moderation act, exactly as the role matrix
    // advertises it. Own messages stay free to pin.
    if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
      throw new ForbiddenException('Missing channel.moderate permission to pin this message');
    }

    if (msg.pinned !== pinned) {
      msg.pinned = pinned;
      await this.messageRepo.save(msg);
    }

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent('channel.pin', { channelId, messageId, pinned }, audience);
  }

  /**
   * Records a vote on a channel poll. Clears the caller's previous selection then
   * stores the new one in `metadata.poll.votesByUser` (empty array = retract vote).
   * A pessimistic write lock serialises concurrent voters on the same row.
   * Rejects votes on a closed poll or on options outside the poll.
   */
  async votePoll(
    channelId: string,
    messageId: string,
    userId: string,
    optionIds: string[]
  ): Promise<ServedChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const selected = Array.isArray(optionIds) ? [...new Set(optionIds)] : [];

    let poll!: ChannelPollMeta;
    await this.messageRepo.manager.transaction(async (manager) => {
      const msg = await manager
        .createQueryBuilder(ChannelMessage, 'm')
        .where('m.id = :messageId AND m.channelId = :channelId', { messageId, channelId })
        .setLock('pessimistic_write')
        .getOne();
      if (!msg) throw new NotFoundException('Message not found');

      const meta = (msg.metadata as { poll?: ChannelPollMeta } | null)?.poll;
      if (!meta) throw new BadRequestException('This message is not a poll');

      if (this.pollIsOver(meta)) {
        throw new ForbiddenException('This poll is closed');
      }
      const unknown = selected.filter((id) => !meta.optionIds.includes(id));
      if (unknown.length > 0) {
        throw new BadRequestException('Vote references unknown option(s)');
      }
      if (!meta.multipleChoice && selected.length > 1) {
        throw new BadRequestException('This poll is single-choice');
      }

      // Null-prototype map prevents prototype pollution via a crafted userId key.
      if (!meta.votesByUser || Object.getPrototypeOf(meta.votesByUser) !== null) {
        meta.votesByUser = Object.assign(Object.create(null), meta.votesByUser);
      }
      // Security: mitigates CodeQL alerts #2477/#2476 — reject dangerous property keys
      if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
        throw new BadRequestException('Invalid user identifier');
      }
      if (selected.length === 0) {
        delete meta.votesByUser[userId];
      } else {
        meta.votesByUser[userId] = selected;
      }

      msg.metadata = { ...msg.metadata, poll: meta };
      await manager.save(msg);
      poll = meta;
    });

    this.logger.log(
      `[POLL] vote channel=${channelId} message=${messageId} user=${userId.slice(0, 8)} options=${selected.length}`
    );

    // Broadcast the updated tally so every member's card refreshes live. The same value the caller
    // gets back, so no member can be told a different poll from the voter.
    const served = this.servedPoll(poll)!;
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll: served },
      audience
    );

    return served;
  }

  /**
   * Closes a poll immediately by forcing its deadline to now, then unpins it.
   * The poll author can always close their own poll; any other member needs a
   * moderation/management permission. Rejects a non-poll message or an already-closed poll.
   */
  async closePoll(
    channelId: string,
    messageId: string,
    userId: string
  ): Promise<ServedChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    let poll!: ChannelPollMeta;
    await this.messageRepo.manager.transaction(async (manager) => {
      const msg = await manager
        .createQueryBuilder(ChannelMessage, 'm')
        .where('m.id = :messageId AND m.channelId = :channelId', { messageId, channelId })
        .setLock('pessimistic_write')
        .getOne();
      if (!msg) throw new NotFoundException('Message not found');

      const meta = (msg.metadata as { poll?: ChannelPollMeta } | null)?.poll;
      if (!meta) throw new BadRequestException('This message is not a poll');

      // Non-authors must hold a moderation permission to close someone else's poll.
      if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
        throw new ForbiddenException('Only the poll author or a moderator can close this poll');
      }

      if (this.pollIsOver(meta)) {
        throw new BadRequestException('This poll is already closed');
      }

      meta.endsAt = new Date().toISOString();
      msg.metadata = { ...msg.metadata, poll: meta };
      msg.pinned = false;
      await manager.save(msg);
      poll = meta;
    });

    this.logger.log(
      `[POLL] closed channel=${channelId} message=${messageId} by=${userId.slice(0, 8)}`
    );

    // Refresh every member's card (now shows as closed) and clear the pinned banner. `closed` is
    // what makes this frame READABLE as a closure: the deadline alone left the peer comparing a
    // server instant to its own clock, and losing.
    const served = this.servedPoll(poll)!;
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll: served },
      audience
    );
    await this.redis.publishChannelEvent(
      'channel.pin',
      { channelId, messageId, pinned: false },
      audience
    );

    return served;
  }

  /**
   * Deletes a message from a channel. The author may always delete their own; deleting someone
   * else's requires `channel.moderate` (or the permissions that subsume it) - this is the
   * "delete other members' messages" half of the moderation permission.
   *
   * The row is dropped outright rather than tombstoned: the content is a ciphertext the server
   * cannot read, so there is nothing to preserve for a "deleted message" placeholder, and DM
   * deletion behaves the same way.
   */
  async deleteChannelMessage(channelId: string, messageId: string, userId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId, channelId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
      throw new ForbiddenException('Missing channel.moderate permission to delete this message');
    }

    await this.messageRepo.delete({ id: messageId, channelId });

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.message.deleted',
      { channelId, messageId, deletedBy: userId },
      audience
    );

    this.logger.log(
      `[CHANNEL] message deleted channel=${channelId} message=${messageId} by=${userId.slice(0, 8)}${
        msg.authorId === userId ? '' : ' (moderation)'
      }`
    );
    return { success: true, channelId, messageId };
  }

  /** Returns the IDs of the pinned messages in a channel. Access-controlled by canAccessChannel. */
  async listPinnedMessageIds(channelId: string, userId: string): Promise<string[]> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const rows = await this.messageRepo.find({
      where: { channelId, pinned: true },
      select: { id: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Returns up to 200 messages from a channel in reverse chronological order (newest first).
   * Access-controlled by canAccessChannel. When `before` (ISO timestamp) is provided, only
   * messages strictly older than it are returned (keyset pagination): callers page back through
   * history by passing the oldest `createdAt` of the previous page, until an empty page is
   * returned. Used for older-message loading and full-text search over the whole channel.
   */
  async listMessages(channelId: string, userId: string, limit = 50, before?: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const safeLimit = Math.min(Math.max(1, limit), 200);
    const beforeDate = before ? new Date(before) : null;
    const hasValidCursor = beforeDate !== null && !Number.isNaN(beforeDate.getTime());

    // THE PAGE IS FILLED WITH BODIES, AND THE SILENT ROWS INSIDE IT COME ALONG.
    //
    // A reaction is a row now, so a plain `take: limit` would let a burst of them push real
    // messages out of the page - a channel that quietly shows less history the more people react
    // to it, with nothing anywhere saying so. So the limit counts non-silent rows, and every
    // silent row newer than the oldest of them is added: bounded by the same window, and complete
    // for every message the page actually shows.
    const bodies = await this.messageRepo.find({
      where: {
        channelId,
        silent: false,
        ...(hasValidCursor ? { createdAt: LessThan(beforeDate) } : {}),
      },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
    const oldestInPage = bodies[bodies.length - 1]?.createdAt ?? null;
    const silentRows =
      bodies.length === 0
        ? []
        : await this.messageRepo.find({
            where: {
              channelId,
              silent: true,
              createdAt: hasValidCursor
                ? And(MoreThanOrEqual(oldestInPage), LessThan(beforeDate))
                : MoreThanOrEqual(oldestInPage),
            },
            order: { createdAt: 'DESC' },
          });
    const msgs = [...bodies, ...silentRows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    // Lazily auto-unpin polls past their deadline so closed polls stop cluttering
    // the pin list (no scheduler: this runs opportunistically on channel open).
    const expiredPollIds = msgs
      .filter((m) => {
        const poll = (m.metadata as { poll?: ChannelPollMeta } | null)?.poll;
        return m.pinned && !!poll && this.pollIsOver(poll);
      })
      .map((m) => m.id);
    if (expiredPollIds.length > 0) {
      await this.messageRepo.update({ id: In(expiredPollIds) }, { pinned: false });
      for (const m of msgs) if (expiredPollIds.includes(m.id)) m.pinned = false;
      this.logger.log(
        `[POLL] auto-unpinned ${expiredPollIds.length} closed poll(s) in channel=${channelId}`
      );
    }

    return msgs.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      senderId: m.authorId,
      ciphertext: m.content,
      nonce: m.nonce ?? null,
      senderSessionId: m.senderSessionId ?? null,
      messageIndex: m.messageIndex ?? null,
      replyTo: m.replyTo ?? null,
      createdAt: m.createdAt,
      pinned: m.pinned,
      // Poll state (label-free) so the client can render results on load.
      poll: this.servedPoll((m.metadata as { poll?: ChannelPollMeta } | null)?.poll),
      silent: m.silent,
    }));
  }

  // ================= ROLE BASE PERMISSIONS =================

  /** Fetches a role's base permissions at the workspace level. */
  async getRoleBasePermissions(roleId: string, actorUserId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');

    // Verify the actor has MANAGE_ROLES or MANAGE_WORKSPACE
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: role.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const actorRoles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = actorRoles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_ROLES)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    return {
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
    };
  }

  /** Updates a role's base permissions at the workspace level. */
  /**
   * The actor's right to edit this workspace's roles - refused here, never returned.
   *
   * Shared by the whole-list write and the single-key one so the two can never disagree about who
   * may edit a role, which is the drift `writePolicyAllows` was extracted to end one feature over.
   */
  private async assertCanManageRoles(role: ChannelRole, actorUserId: string): Promise<void> {
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: role.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const actorRoles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = actorRoles.some(
        (r) =>
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
          r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_ROLES)
      );
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');
  }

  /**
   * Tells the community what a role now grants, so no open grid keeps showing what it used to.
   *
   * A ROLE'S PERMISSIONS ARE NOT PRIVATE WITHIN THE COMMUNITY - the workspace listing already hands
   * every member the full `roles` array - so the audience is the membership rather than the
   * administrators, and this discloses nothing a member could not already read.
   */
  private async announceRolePermissions(role: ChannelRole): Promise<void> {
    const members = await this.memberRepo.find({ where: { workspaceId: role.workspaceId } });
    await this.redis.publishChannelEvent(
      'workspace.role.permissions',
      { workspaceId: role.workspaceId, roleId: role.id, permissions: role.permissions },
      members.map((m) => m.userId)
    );
  }

  /**
   * Grants or revokes ONE permission on a role, applied to the row as it stands.
   *
   * WHY THIS EXISTS BESIDE THE WHOLE-LIST WRITE. Clicking a cell in the permission grid IS a delta -
   * "grant this one key" - and it was being sent as the role's entire list, computed from whatever
   * the browser happened to be holding. Two administrators toggling two DIFFERENT permissions of one
   * role at the same moment therefore did not race: the second write carried a list built before the
   * first one landed and simply erased it. COMM-20 measured it on production on 2026-08-20 - the
   * second administrator's grid went on showing a permission the server had dropped AND one it had
   * never stored, indefinitely, with nothing to say so.
   *
   * **TWO EDITS THAT COMMUTE MUST BE SENT AS THE OPERATIONS THEY ARE.** Expressed as a delta there
   * is nothing to merge and nothing to lose: each write reads the current row and changes one key.
   * A whole-list write with optimistic concurrency would have been the other answer, and a worse
   * one - it turns two compatible edits into a conflict somebody has to resolve by hand.
   *
   * **AND THE DELTA IS APPLIED UNDER A ROW LOCK, because a delta computed in application memory is
   * the same lost update one layer down.** COMM-20 measured that too, on 2026-08-20, against the
   * first fix: the wire carried one key, both requests still read the same row before either wrote,
   * and the second still erased the first. See the transaction below.
   */
  async setRoleBasePermission(roleId: string, actorUserId: string, key: string, granted: boolean) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    await this.assertCanManageRoles(role, actorUserId);

    const validPermissions = Object.values(CHANNEL_PERMISSIONS) as string[];
    if (!validPermissions.includes(key)) {
      throw new BadRequestException(`Invalid permission: ${key}`);
    }

    // THE DELTA IS APPLIED WHERE THE ROW LIVES, NOT WHERE THIS PROCESS HAPPENS TO HOLD A COPY.
    //
    // Sending one key instead of the whole list moved the lost update off the wire; it did not
    // remove it. Read-modify-write in application memory is the same defect one layer down: two
    // requests arriving together each read `["channel.moderate", ...]`, each compute their own next
    // list from it, and each write the whole row - so the second erases the first exactly as the
    // browser used to. MEASURED ON PRODUCTION 2026-08-20, by COMM-20, against the fix for COMM-20.
    //
    // The lock is what serialises them, and it is taken by the DATABASE on the row itself: nothing
    // here waits, retries or compares versions, and two nodes behind the load balancer are as safe
    // as two requests on one. The critical section holds one SELECT and one UPDATE of a single row;
    // the authorisation above and the announcement below are deliberately outside it.
    const saved = await this.roleRepo.manager.transaction(async (em) => {
      const locked = await em.findOne(ChannelRole, {
        where: { id: roleId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Role not found');

      const current = locked.permissions ?? [];
      locked.permissions = granted
        ? [...new Set([...current, key])]
        : current.filter((p) => p !== key);
      return em.save(ChannelRole, locked);
    });

    this.logger.log(
      `[ROLE] ${granted ? 'granted' : 'revoked'} ${key} role=${roleId} ` +
        `by=${actorUserId.slice(0, 8)} perms=${saved.permissions.length}`
    );
    await this.announceRolePermissions(saved);

    return { roleId: saved.id, roleName: saved.name, permissions: saved.permissions };
  }

  async setRoleBasePermissions(roleId: string, actorUserId: string, permissions: string[]) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    await this.assertCanManageRoles(role, actorUserId);

    // A KEY THIS SERVER RETIRED IS DROPPED, NOT REFUSED - and it is the only exception.
    //
    // `channel.access` and `channel.send` were removed on 2026-08-19 because nothing enforced them.
    // The fleet is mixed by construction - A1's APK carries its own bundle and no deploy reaches it
    // - so an old client still renders the eight-row grid and PUTs all eight on any toggle. Refusing
    // the whole list would turn every role edit on that client into a 400 over two keys the server
    // itself put in the grid. Accepting them would resurrect them. Dropping them applies exactly
    // what the admin asked for and nothing else.
    //
    // Loud on purpose: this is the only thing that will ever say an old client is still out there,
    // and the branch goes the day it stops firing (see legacy-compatibility).
    const retired = permissions.filter((p) => RETIRED_PERMISSIONS.includes(p));
    if (retired.length > 0) {
      this.logger.warn(
        `[ROLE] RETIRED_PERMISSION_SENT role=${roleId} by=${actorUserId.slice(0, 8)} ` +
          `keys=${retired.join(',')} - a client built before 2026-08-19 is still in the fleet`
      );
    }
    const requested = permissions.filter((p) => !RETIRED_PERMISSIONS.includes(p));

    // Anything else unknown is a real error and still fails the whole update: a permission the
    // server cannot name is a client asking for a capability that does not exist, and silently
    // granting the remainder would report success for a request nobody can read back.
    const validPermissions = Object.values(CHANNEL_PERMISSIONS) as string[];
    const invalid = requested.filter((p) => !validPermissions.includes(p));
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid permissions: ${invalid.join(', ')}`);
    }

    role.permissions = requested;
    await this.roleRepo.save(role);

    this.logger.log(
      `[ROLE] permissions updated role=${roleId} by=${actorUserId.slice(0, 8)} perms=${requested.length}`
    );
    await this.announceRolePermissions(role);

    return {
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
    };
  }
}
