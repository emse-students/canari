import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Inject,
  UseGuards,
  Headers,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, DataSource, In } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  assertCallerOwnsUserId,
} from '../utils/sanitize';
import { RETENTION_WINDOW_MS } from '../retention.constants';
import { resolveUserDisplayNamesBatch } from '../utils/display-name';

/** Group membership management: add/remove members, list members, list user groups. */
@Controller()
export class MembersController {
  private readonly logger = new Logger(MembersController.name);

  constructor(
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(UserDismissedGroup)
    private dismissedRepo: Repository<UserDismissedGroup>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly dataSource: DataSource
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Authorizes an add/remove membership mutation on `safeGroupId`. The caller (nginx-injected,
   * HMAC-bound `x-user-id`) is allowed only when one of the following holds:
   *  - it is a platform global admin (`x-global-admin: true`);
   *  - it is already a member of the group - covers invites, welcome_request re-adds, and the
   *    inviter/joiner backfill paths, which all run as an existing member (the inviter registers
   *    an invitee BEFORE sending the Welcome, so the invitee is a member by the time it self-heals);
   *  - (add only) the group has no members yet AND the caller is adding itself - the group-creation
   *    bootstrap, where the creator registers its own userId first before anyone else exists.
   *
   * Blocks the self-join escalation (audit S1): a non-member cannot insert itself into a populated
   * group's `dm_group_members` and then external-join via the served GroupInfo, nor remove others
   * from a group it does not belong to (audit S5). When `x-user-id` is absent (deployments without
   * INTERNAL_SHARED_SECRET), the check is a no-op to preserve legacy behavior, matching
   * `assertCallerOwnsUserId`.
   */
  private async assertCallerMayMutateMembership(
    safeGroupId: string,
    targetUserId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    allowCreationBootstrap: boolean
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;

    const callerMemberships = await this.groupMemberRepo.count({
      where: { groupId: safeGroupId, userId: caller },
    });
    if (callerMemberships > 0) return;

    // Group-creation bootstrap: the creator adds its own userId while the group is still empty.
    if (allowCreationBootstrap && caller === targetUserId) {
      const memberCount = await this.groupMemberRepo.count({
        where: { groupId: safeGroupId },
      });
      if (memberCount === 0) return;
    }

    throw new ForbiddenException('Caller is not authorized to modify this group membership');
  }

  /**
   * Authorizes a roster read on `safeGroupId`. The caller (nginx-injected, HMAC-bound `x-user-id`)
   * must be a platform global admin or an existing member of the group. Blocks roster enumeration
   * by non-members (audit S5): the user list and active-device list are group metadata that leak
   * social graph / device topology. Freshly-invited joiners are registered as members BEFORE their
   * Welcome, so recovery/re-invite reads still pass. No-op when `x-user-id` is absent (legacy
   * deployments without INTERNAL_SHARED_SECRET), matching `assertCallerOwnsUserId`.
   */
  private async assertCallerIsGroupMember(
    safeGroupId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;
    const callerMemberships = await this.groupMemberRepo.count({
      where: { groupId: safeGroupId, userId: caller },
    });
    if (callerMemberships > 0) return;
    throw new ForbiddenException('Caller is not a member of this group');
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/users/:userId/groups')
  /**
   * Lists all groups a user belongs to, ordered by last update (most recent first).
   * The client relies on this order to seed the conversation list before local DB is ready.
   */
  async getUserGroups(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot list another user's groups"
    );
    const memberships = await this.groupMemberRepo.find({
      where: { userId: safeUserId },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    if (groupIds.length === 0) {
      this.logger.log(`[USER_GROUPS] user=${safeUserId} groups=0`);
      return [];
    }
    const groups = await this.groupRepo.find({ where: { id: In(groupIds) } });
    const activeGroups = groups
      .filter((g) => !g.deletedAt)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    this.logger.log(
      `[USER_GROUPS] user=${safeUserId} groups=${activeGroups.length} ids=${activeGroups.map((g) => g.id).join(',')}`
    );
    return activeGroups.map((g) => ({
      groupId: g.id,
      name: g.name,
      isGroup: g.isGroup,
      imageMediaId: g.imageMediaId ?? null,
      deletedAt: g.deletedAt ?? null,
    }));
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/users/:userId/dismissed-groups')
  /**
   * Lists the group IDs this user has voluntarily dismissed (manual delete/leave). The client's
   * discovery purges any local conversation in this set on ALL the user's devices, instead of
   * showing the "deleted" banner reserved for peer-deletions/exclusions.
   */
  async getDismissedGroups(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<string[]> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot read another user's dismissed groups"
    );
    const rows = await this.dismissedRepo.find({
      where: { userId: safeUserId },
    });
    return rows.map((r) => r.groupId);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/users/:userId/dismissed-groups')
  /** Marks a group as dismissed by this user (idempotent). Propagates the local delete/leave to the user's other devices. */
  async dismissGroup(
    @Param('userId') userId: string,
    @Body() body: { groupId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot dismiss a group for another user'
    );
    const safeGroupId = sanitizeQueryValue(body?.groupId ?? '', 'groupId');
    // Idempotent : ON CONFLICT DO NOTHING via la contrainte unique (userId, groupId).
    await this.dismissedRepo
      .createQueryBuilder()
      .insert()
      .values({ userId: safeUserId, groupId: safeGroupId })
      .orIgnore()
      .execute();
    this.logger.log(`[DISMISS] user=${safeUserId} group=${safeGroupId}`);
    return { status: 'dismissed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/users/:userId/dismissed-groups/:groupId')
  /** Un-dismisses a group (called when the user is re-added via a fresh Welcome - they want it back). */
  async undismissGroup(
    @Param('userId') userId: string,
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot un-dismiss a group for another user'
    );
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.dismissedRepo.delete({
      userId: safeUserId,
      groupId: safeGroupId,
    });
    this.logger.log(`[UNDISMISS] user=${safeUserId} group=${safeGroupId}`);
    return { status: 'undismissed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/members')
  /** Adds a member to a group and registers their device-group membership as pending. */
  async addGroupMember(
    @Param('groupId') groupId: string,
    @Body() body: { userId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const traceId = this.makeTraceId('add-member');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    await this.assertCallerMayMutateMembership(
      safeGroupId,
      safeUserId,
      headerUserId,
      headerGlobalAdmin,
      true // allow the group-creation bootstrap (creator registers itself into an empty group)
    );
    this.logger.log(`[ADD_MEMBER][${traceId}] START group=${safeGroupId} user=${safeUserId}`);

    // Atomic upsert: INSERT ... ON CONFLICT DO UPDATE avoids the findOne+save race.
    // Window aligned with retention: a still-recoverable device (last seen < 90 days)
    // must receive a pending membership even if idle for > 30 days.
    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const userDevices = await this.keyPackageRepo.find({
      where: { userId: safeUserId, createdAt: MoreThanOrEqual(cutoff) },
    });

    await this.dataSource.transaction(async (manager) => {
      // Upsert GroupMember: updates joinedAt if the row already exists.
      await manager
        .createQueryBuilder()
        .insert()
        .into(GroupMember)
        .values({
          groupId: safeGroupId,
          userId: safeUserId,
          joinedAt: new Date(),
        })
        .orUpdate(['joinedAt'], ['groupId', 'userId'])
        .execute();

      // Upsert DeviceGroupMembership for each active device: no-op if already present.
      for (const device of userDevices) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(DeviceGroupMembership)
          .values({
            userId: safeUserId,
            deviceId: device.deviceId,
            groupId: safeGroupId,
            status: 'pending',
          })
          .orIgnore()
          .execute();
      }
    });

    // NB: NOT added to group:members Redis here - devices enter the routing
    // set only when their Welcome is sent (sendWelcome sets status to active).
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length}`
    );
    return { status: 'added' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/user-members')
  /** Returns user-level membership from dm_group_members (no device-status filter). */
  async getGroupUserMembers(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.assertCallerIsGroupMember(safeGroupId, headerUserId, headerGlobalAdmin);
    const rows = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: { userId: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameMap = await resolveUserDisplayNamesBatch(this.dataSource.manager, userIds);
    this.logger.log(`[GET_USER_MEMBERS] group=${safeGroupId} count=${rows.length}`);
    return rows.map((r) => ({
      userId: r.userId,
      displayName: nameMap.get(r.userId) ?? null,
    }));
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/members')
  /**
   * Returns one `{ userId, deviceId }` entry per **active device** in `groupId`.
   * Sourced from `dm_device_group_memberships WHERE status = 'active'`.
   *
   * Use this endpoint for:
   * - MLS tree occupancy / stale-leaf detection (device-level identity required)
   * - Repopulating the Redis `group:members:` routing cache after a cache miss
   *
   * Do NOT use this to determine which users may be re-invited on recovery.
   * A group can have zero active device entries even though users still belong to it
   * (e.g. after a device fresh-start clears all DeviceGroupMembership rows). Use
   * `GET mls/groups/:groupId/user-members` (dm_group_members) for that purpose.
   */
  async getGroupMembers(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.assertCallerIsGroupMember(safeGroupId, headerUserId, headerGlobalAdmin);
    const rows = await this.deviceGroupRepo.find({
      where: { groupId: safeGroupId, status: 'active' as const },
      select: { userId: true, deviceId: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameMap = await resolveUserDisplayNamesBatch(this.dataSource.manager, userIds);
    this.logger.log(`[GET_MEMBERS] group=${safeGroupId} count=${rows.length}`);
    return rows.map((r) => ({
      userId: r.userId,
      deviceId: r.deviceId,
      displayName: nameMap.get(r.userId) ?? null,
    }));
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId/members/:userId')
  /** Removes a user from a group server-side (deletes their GroupMember record). */
  async removeGroupMember(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    // Only an existing member/admin of the group may remove a user (audit S5): mirrors the MLS
    // remove-commit semantics (removes are issued by members) and blocks the delivery-level DoS
    // where a non-member kicks anyone. Self-leave passes (the caller is a member). No creation
    // bootstrap on removal (a group is never emptied by adding-self), hence allowCreationBootstrap=false.
    await this.assertCallerMayMutateMembership(
      safeGroupId,
      safeUserId,
      headerUserId,
      headerGlobalAdmin,
      false
    );

    // Remove all per-device memberships for this user in the group to keep
    // server-side metadata aligned with the MLS remove commit semantics.
    const deviceMembershipDelete = await this.deviceGroupRepo.delete({
      groupId: safeGroupId,
      userId: safeUserId,
    });

    await this.groupMemberRepo.delete({
      groupId: safeGroupId,
      userId: safeUserId,
    });

    // Remove all devices of this user from the Redis set
    const members = await this.redis.smembers(`group:members:${safeGroupId}`);
    const toRemove = members.filter((m) => m.startsWith(`${safeUserId}:`));
    if (toRemove.length > 0) {
      await this.redis.srem(`group:members:${safeGroupId}`, ...toRemove);
    }

    this.logger.log(
      `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} redisRemoved=${toRemove.length} deviceMembershipsDeleted=${deviceMembershipDelete.affected ?? 0}`
    );
    return { status: 'removed' };
  }
}
