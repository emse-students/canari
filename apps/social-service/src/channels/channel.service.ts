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
import {
  createDistributionGroup,
  deleteDistributionGroup,
  publishDistributionGroupInfo,
  readDistributionGroup,
  type DistributionGroupRef,
} from './distribution-group.client';

import {
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
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
   * Simple channel access model:
   *  - public channel → every workspace member can access;
   *  - private channel → admins (workspace.manage) always, plus users explicitly in `allowedUsers`.
   * Reading/joining is independent of who may write (see canWriteToChannel).
   */
  private async canAccessChannel(
    channel: Channel,
    _member: ChannelMember,
    userId?: string
  ): Promise<boolean> {
    if (!channel.isPrivate) return true;
    if (!userId) return false;
    const normalized = userId.trim().toLowerCase();
    if ((channel.allowedUsers || []).includes(normalized)) return true;
    // Admins reach every channel, even private ones they were never explicitly added to.
    return this.memberHasWorkspacePermission(
      channel.workspaceId,
      normalized,
      CHANNEL_PERMISSIONS.MANAGE_WORKSPACE
    );
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
    if (policy === 'admins') {
      return roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
    }
    // admins_moderators
    return roles.some(
      (r) =>
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_MESSAGES) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
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
    const channels = await this.channelRepo.find({ where: { workspaceId }, select: { id: true } });
    const channelIds = channels.map((c) => c.id);

    // BEFORE the transaction, and allowed to abort it. The distribution group lives in another
    // service, so it cannot join the transaction; doing it afterwards as best-effort would turn a
    // failed call into an orphan group nothing names any more - the very shape of row the
    // 2026-08-17 purge had to find by hand. Failing here leaves the community intact and the whole
    // deletion retryable, which is the only outcome that stays reconcilable.
    await deleteDistributionGroup(this.internalSecret, workspaceId);

    await this.workspaceRepo.manager.transaction(async (mgr) => {
      await mgr.delete(ChannelMessage, { workspaceId });
      await mgr.delete(ChannelMember, { workspaceId });
      await mgr.delete(ChannelRole, { workspaceId });
      await mgr.delete(WorkspaceInvite, { workspaceId });
      await mgr.delete(Channel, { workspaceId });
      await mgr.delete(Workspace, { id: workspaceId });
    });

    this.logger.log(
      `[WORKSPACE] hard delete workspace=${workspaceId} channels=${channelIds.length} reason=${reason}`
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
   */
  async repairWorkspacesAfterAccountDeletion(workspaceIds: string[]): Promise<void> {
    for (const workspaceId of workspaceIds) {
      try {
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
      where: { id: workspaceId, archived: false },
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
      where: { id: invite.workspaceId, archived: false },
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
      where: { id: invite.workspaceId, archived: false },
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
      savedWs.distributionGroupId = await createDistributionGroup(this.internalSecret, savedWs.id);
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
      where: { id: workspaceId, archived: false },
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

    const ref = await readDistributionGroup(this.internalSecret, workspaceId);
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
      `[DISTRIBUTION_GROUP] served workspace=${workspaceId} user=${userId.slice(0, 8)} group=${ref.groupId} published=${ref.groupInfo !== null}`
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
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    await this.assertWorkspaceMember(workspaceId, userId);

    const result = await publishDistributionGroupInfo(
      this.internalSecret,
      workspaceId,
      groupInfo,
      baseEpoch
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] published workspace=${workspaceId} user=${userId.slice(0, 8)} epoch=${baseEpoch} stored=${result.stored}`
    );
    return result;
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
    // `archived: false` rather than a post-lookup check: a deleted community must be a 404
    // on its own slug, not a readable tombstone.
    const ws = await this.workspaceRepo.findOne({ where: { slug, archived: false } });
    if (!ws) throw new NotFoundException('Workspace not found');

    const normalizedUserId = (userId ?? '').trim().toLowerCase();
    const members = await this.memberRepo.find({ where: { workspaceId: ws.id } });
    const viewerMember = members.find((m) => m.userId.trim().toLowerCase() === normalizedUserId);
    if (!viewerMember) throw new ForbiddenException('Not a member of this workspace');

    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });

    const allChannels = await this.channelRepo.find({
      where: { workspaceId: ws.id, archived: false },
    });
    const channels: Array<{
      id: string;
      workspaceId: string;
      name: string;
      visibility: 'public' | 'private';
      writePolicy: ChannelWritePolicy;
    }> = [];
    for (const ch of allChannels) {
      if (!(await this.canAccessChannel(ch, viewerMember, normalizedUserId))) continue;
      // Projected field by field, never the entity: a channel row carries columns no caller needs,
      // and serializing the entity handed every one of them to the client.
      channels.push({
        id: ch.id,
        workspaceId: ch.workspaceId,
        name: ch.name,
        visibility: ch.isPrivate ? 'private' : 'public',
        writePolicy: ch.writePolicy ?? 'everyone',
      });
    }

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

    return { workspace: { ...ws, viewerCanManage, viewerCanModerate }, channels, members, roles };
  }

  /** Returns all workspaces the user belongs to (derived from their ChannelMember records). */
  async listWorkspacesForUser(userId: string) {
    const memberships = await this.memberRepo.find({ where: { userId } });
    if (memberships.length === 0) return [];

    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
    // Membership rows survive a community deletion (so it stays recoverable); the archived
    // filter is what actually removes it from every member's sidebar.
    const workspaces = await this.workspaceRepo.find({
      where: { id: In(workspaceIds), archived: false },
    });

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
      allowedRoles: [],
      allowedUsers: isPrivate ? [input.actorUserId.trim().toLowerCase()] : [],
    });
    const savedChannel = await this.channelRepo.save(channel);

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
      where: { id: workspaceId, archived: false },
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

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, name: channel.name, workspaceId: channel.workspaceId },
      workspaceMemberIds
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

    channel.isPrivate = isPrivate;
    channel.allowedUsers = isPrivate ? allowedUserIds.map((u) => u.trim().toLowerCase()) : [];
    if (writePolicy) {
      channel.writePolicy = writePolicy;
    }
    await this.channelRepo.save(channel);

    return {
      ok: true,
      channelId,
      isPrivate: channel.isPrivate,
      allowedUsers: channel.allowedUsers,
      writePolicy: channel.writePolicy,
    };
  }

  /** Marks a channel as archived (hidden from listings) and broadcasts a channel.deleted event to workspace members. */
  async archiveChannel(channelId: string, actorUserId: string) {
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

    channel.archived = true;
    await this.channelRepo.save(channel);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.deleted',
      { channelId, workspaceId: channel.workspaceId },
      workspaceMemberIds
    );

    return { success: true };
  }

  /** Lists all non-archived channels the user can access in a workspace. */
  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const channels = await this.channelRepo.find({ where: { workspaceId, archived: false } });
    const accessible: typeof channels = [];
    for (const ch of channels) {
      if (await this.canAccessChannel(ch, member, userId)) {
        accessible.push(ch);
      }
    }
    return accessible.map((channel) => ({
      id: channel.id,
      workspaceId: channel.workspaceId,
      name: channel.name,
      visibility: channel.isPrivate ? 'private' : 'public',
    }));
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

    // Publish event to notify connected clients
    if (isNewMember) {
      const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
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
        workspaceMemberIds
      );
    }

    return { success: true };
  }

  /**
   * Returns false when the user has no active MLS device registered in chat-delivery.
   * Fails open (returns true) on network error so a misconfigured secret never blocks invitations.
   */
  private async userHasMlsDevices(userId: string): Promise<boolean> {
    if (!this.internalSecret) return true;
    try {
      const res = await fetch(deliveryUrl(`mls/devices/${encodeURIComponent(userId)}`), {
        headers: { 'X-Internal-Secret': this.internalSecret },
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) return true;
      const devices: unknown[] = await res.json();
      return devices.length > 0;
    } catch {
      return true;
    }
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
    const hasDevices = await this.userHasMlsDevices(input.targetUserId);
    if (!hasDevices) {
      throw new BadRequestException(
        `User ${input.targetUserId} has not yet set up Canari on any device.`
      );
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

    // Publish event to notify the invited user and connected clients
    if (isNewMember) {
      const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
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
        workspaceMemberIds
      );

      // For private channels with user-based access, add the new member to allowedUsers. Nothing
      // else on the row changes any more, so the save belongs to this branch alone.
      if (channel.isPrivate) {
        const existing = channel.allowedUsers || [];
        const normalized = input.targetUserId.trim().toLowerCase();
        if (!existing.includes(normalized)) {
          channel.allowedUsers = [...existing, normalized];
          await this.channelRepo.save(channel);
        }
      }
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
    // gets the same answer rather than an archived community nobody belongs to.
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
      const normalized = targetUserId.trim().toLowerCase();
      channel.allowedUsers = (channel.allowedUsers || []).filter((u) => u !== normalized);
      await this.channelRepo.save(channel);
    }

    // Notify the removed user and workspace members
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    const notifyIds = [...new Set([...workspaceMemberIds, targetUserId])];
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
    if (scope === 'channel' && !(await this.canAccessChannel(channel, actorMember, actorUserId))) {
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
    if (!(await this.canAccessChannel(channel, member, input.senderId))) {
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

    // Publish event fire-and-forget - do not block the HTTP response
    this.getWorkspaceMemberIds(channel.workspaceId)
      .then((workspaceMemberIds) =>
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
            poll: pollMeta,
            pinned: savedMsg.pinned,
          },
          workspaceMemberIds
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

    const recipients: ChannelMember[] = [];
    for (const member of members) {
      if (member.userId === input.senderId) continue;
      if (!(await this.canAccessChannel(channel, member, member.userId))) continue;
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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
    if (!(await this.canAccessChannel(channel, member, userId))) {
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.typing',
      { channelId, userId, state: isTyping ? 'start' : 'stop' },
      workspaceMemberIds
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.pin',
      { channelId, messageId, pinned },
      workspaceMemberIds
    );
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
  ): Promise<ChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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

      if (meta.endsAt && new Date(meta.endsAt).getTime() <= Date.now()) {
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
      `[POLL] vote channel=${channelId} message=${messageId} user=${userId} options=${selected.length}`
    );

    // Broadcast the updated tally so every member's card refreshes live.
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll },
      workspaceMemberIds
    );

    return poll;
  }

  /**
   * Closes a poll immediately by forcing its deadline to now, then unpins it.
   * The poll author can always close their own poll; any other member needs a
   * moderation/management permission. Rejects a non-poll message or an already-closed poll.
   */
  async closePoll(channelId: string, messageId: string, userId: string): Promise<ChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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

      if (meta.endsAt && new Date(meta.endsAt).getTime() <= Date.now()) {
        throw new BadRequestException('This poll is already closed');
      }

      meta.endsAt = new Date().toISOString();
      msg.metadata = { ...msg.metadata, poll: meta };
      msg.pinned = false;
      await manager.save(msg);
      poll = meta;
    });

    this.logger.log(`[POLL] closed channel=${channelId} message=${messageId} by=${userId}`);

    // Refresh every member's card (now shows as closed) and clear the pinned banner.
    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll },
      workspaceMemberIds
    );
    await this.redis.publishChannelEvent(
      'channel.pin',
      { channelId, messageId, pinned: false },
      workspaceMemberIds
    );

    return poll;
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId, channelId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
      throw new ForbiddenException('Missing channel.moderate permission to delete this message');
    }

    await this.messageRepo.delete({ id: messageId, channelId });

    const workspaceMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    await this.redis.publishChannelEvent(
      'channel.message.deleted',
      { channelId, messageId, deletedBy: userId },
      workspaceMemberIds
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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
    if (!member || !(await this.canAccessChannel(channel, member, userId))) {
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
    const now = Date.now();
    const expiredPollIds = msgs
      .filter((m) => {
        const poll = (m.metadata as { poll?: ChannelPollMeta } | null)?.poll;
        return m.pinned && poll?.endsAt && new Date(poll.endsAt).getTime() <= now;
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
      poll: (m.metadata as { poll?: ChannelPollMeta } | null)?.poll ?? null,
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
  async setRoleBasePermissions(roleId: string, actorUserId: string, permissions: string[]) {
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

    // Validate that permissions are valid
    const validPermissions = Object.values(CHANNEL_PERMISSIONS) as string[];
    const invalid = permissions.filter((p) => !validPermissions.includes(p));
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid permissions: ${invalid.join(', ')}`);
    }

    role.permissions = permissions;
    await this.roleRepo.save(role);

    this.logger.log(
      `[ROLE] permissions updated role=${roleId} by=${actorUserId.slice(0, 8)} perms=${permissions.length}`
    );

    return {
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
    };
  }
}
