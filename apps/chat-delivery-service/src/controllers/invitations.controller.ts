import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Inject,
  BadRequestException,
  NotFoundException,
  UseGuards,
  Headers,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { IsNull } from 'typeorm';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue, assertCallerOwnsUserId } from '../utils/sanitize';
import { In } from 'typeorm';
import { MessagingService } from '../services/messaging.service';

/** Device-group membership management: pending invitations, status updates, kick-stale. */
@Controller()
export class InvitationsController {
  private readonly logger = new Logger(InvitationsController.name);

  constructor(
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group)
    private groupRepo: Repository<Group>,
    @InjectRepository(GroupInvite)
    private groupInviteRepo: Repository<GroupInvite>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly messagingService: MessagingService,
  ) {}

  /** Whether an invite is still usable (not revoked/expired/exhausted). */
  private groupInviteIsValid(invite: GroupInvite): boolean {
    if (invite.revoked) return false;
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now())
      return false;
    if (invite.maxUses != null && invite.uses >= invite.maxUses) return false;
    return true;
  }

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Caller must belong to the group unless they are a global admin. */
  private async assertCallerIsGroupMember(
    callerUserId: string,
    groupId: string,
    headerGlobalAdmin?: string,
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const membership = await this.groupMemberRepo.findOne({
      where: { userId: callerUserId, groupId },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this group');
    }
  }

  // ── Shareable group invite links ───────────────────────────────────────────

  /** Creates a shareable invite link for an MLS group chat (caller must be a member). */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/invites')
  async createGroupInvite(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
    @Body() body?: { expiresAt?: string | null; maxUses?: number | null },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const callerId = sanitizeQueryValue(headerUserId ?? '', 'userId');
    await this.assertCallerIsGroupMember(
      callerId,
      safeGroupId,
      headerGlobalAdmin,
    );
    const group = await this.groupRepo.findOne({
      where: { id: safeGroupId, deletedAt: IsNull() },
    });
    if (!group) throw new NotFoundException('Group not found');
    if (!group.isGroup) {
      throw new BadRequestException(
        'Invites are only available for group chats',
      );
    }
    const invite = this.groupInviteRepo.create({
      groupId: safeGroupId,
      token: crypto.randomBytes(18).toString('base64url'),
      createdBy: callerId,
      expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
      maxUses: body?.maxUses ?? null,
      uses: 0,
      revoked: false,
    });
    const saved = await this.groupInviteRepo.save(invite);
    this.logger.log(
      `[GROUP_INVITE] created group=${safeGroupId} by=${callerId.slice(0, 8)}`,
    );
    return { token: saved.token };
  }

  /** Preview of a group invite (group name) shown before joining. */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/group-invites/:token')
  async getGroupInvitePreview(@Param('token') token: string) {
    const invite = await this.groupInviteRepo.findOne({ where: { token } });
    if (!invite || !this.groupInviteIsValid(invite)) {
      return { valid: false, groupId: null, groupName: null };
    }
    const group = await this.groupRepo.findOne({
      where: { id: invite.groupId, deletedAt: IsNull() },
    });
    if (!group || !group.isGroup)
      return { valid: false, groupId: null, groupName: null };
    return { valid: true, groupId: group.id, groupName: group.name ?? null };
  }

  /**
   * Accepts a group invite: creates the caller's GroupMember + `pending`
   * DeviceGroupMembership rows so the existing pipeline (any online member,
   * add-lock, addMember + Welcome) adds them. No crypto happens here.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/group-invites/:token/accept')
  async acceptGroupInvite(
    @Param('token') token: string,
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const callerId = sanitizeQueryValue(headerUserId ?? '', 'userId');
    const invite = await this.groupInviteRepo.findOne({ where: { token } });
    if (!invite || !this.groupInviteIsValid(invite)) {
      throw new NotFoundException('Invalid or expired invitation.');
    }
    const group = await this.groupRepo.findOne({
      where: { id: invite.groupId, deletedAt: IsNull() },
    });
    if (!group || !group.isGroup)
      throw new NotFoundException('Group not found');

    const existing = await this.groupMemberRepo.findOne({
      where: { groupId: group.id, userId: callerId },
    });
    if (existing) return { groupId: group.id, alreadyMember: true };

    // The invitee needs at least one non-revoked KeyPackage so a member can add them.
    const keyPackages = await this.keyPackageRepo.find({
      where: { userId: callerId },
    });
    const revoked = await this.revokedDeviceRepo.find({
      where: { userId: callerId },
    });
    const revokedKeys = new Set(
      revoked.map((r) => `${r.userId}:${r.deviceId}`),
    );
    const deviceIds = [
      ...new Set(
        keyPackages
          .filter((kp) => !revokedKeys.has(`${kp.userId}:${kp.deviceId}`))
          .map((kp) => kp.deviceId),
      ),
    ];
    if (deviceIds.length === 0) {
      throw new BadRequestException(
        'No active device - open Canari on a device and try again.',
      );
    }

    // 1. User-level membership (authoritative "who belongs to the group").
    await this.groupMemberRepo
      .createQueryBuilder()
      .insert()
      .into(GroupMember)
      .values({ groupId: group.id, userId: callerId, role: 'member' as const })
      .orIgnore()
      .execute();

    // 2. Pending device memberships → fulfilled by processPendingInvitations on members.
    await this.deviceGroupRepo
      .createQueryBuilder()
      .insert()
      .into(DeviceGroupMembership)
      .values(
        deviceIds.map((deviceId) => ({
          userId: callerId,
          deviceId,
          groupId: group.id,
          status: 'pending' as const,
        })),
      )
      .orIgnore()
      .execute();

    await this.groupInviteRepo.increment({ id: invite.id }, 'uses', 1);
    this.logger.log(
      `[GROUP_INVITE] accepted group=${group.id} user=${callerId.slice(0, 8)} devices=${deviceIds.length}`,
    );

    // Trigger the add immediately instead of waiting for a member's next sync:
    // notifyWelcomeRequest forwards a welcome_request to an online member (who runs
    // addMember + Welcome at once) and, if none is online, wakes them via FCM.
    // Best-effort - the pending rows above remain the durable fallback.
    for (const deviceId of deviceIds) {
      try {
        await this.messagingService.notifyWelcomeRequest({
          groupId: group.id,
          requesterUserId: callerId,
          requesterDeviceId: deviceId,
        });
      } catch (e) {
        this.logger.warn(
          `[GROUP_INVITE] notifyWelcomeRequest failed group=${group.id} device=${deviceId} err=${
            e instanceof Error ? e.message : 'unknown'
          }`,
        );
      }
    }

    return { groupId: group.id, alreadyMember: false };
  }

  /**
   * Returns all pending device-group memberships for groups this device belongs to.
   * Any online device can then process these by committing Add + sending Welcome.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/invitations/pending/:userId/:deviceId')
  async getPendingInvitations(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const traceId = this.makeTraceId('pending');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot list pending invitations for another user',
    );
    this.logger.log(
      `[PENDING][${traceId}] START user=${safeUserId} device=${safeDeviceId}`,
    );

    // 1. Get groups where this device is already active (has processed its Welcome)
    const myMemberships = await this.deviceGroupRepo.find({
      where: {
        userId: safeUserId,
        deviceId: safeDeviceId,
        status: 'active' as const,
      },
    });
    const myGroupIds = myMemberships.map((m) => m.groupId);
    if (myGroupIds.length === 0) {
      this.logger.log(
        `[PENDING][${traceId}] No active membership for ${safeUserId}:${safeDeviceId}`,
      );
      return [];
    }

    // 2. Find all pending memberships in those groups.
    // Uses In() to generate a single WHERE groupId IN (...) AND status = 'pending' predicate
    // instead of N OR clauses (one per group), which is far more efficient in PostgreSQL.
    const pending = await this.deviceGroupRepo.find({
      where: { groupId: In(myGroupIds), status: 'pending' as const },
    });

    if (pending.length === 0) {
      this.logger.log(
        `[PENDING][${traceId}] DONE groups=${myGroupIds.length} invitations=0`,
      );
      return [];
    }

    const inviteeUserIds = [...new Set(pending.map((p) => p.userId))];
    const revokedRows = await this.revokedDeviceRepo.find({
      where: { userId: In(inviteeUserIds) },
    });
    const revokedKeys = new Set(
      revokedRows.map((r) => `${r.userId}:${r.deviceId}`),
    );
    const keyPackages = await this.keyPackageRepo.find({
      where: { userId: In(inviteeUserIds) },
    });
    const inviteableKeys = new Set(
      keyPackages
        .filter((kp) => !revokedKeys.has(`${kp.userId}:${kp.deviceId}`))
        .map((kp) => `${kp.userId}:${kp.deviceId}`),
    );
    const actionable = pending.filter((p) =>
      inviteableKeys.has(`${p.userId}:${p.deviceId}`),
    );
    const skipped = pending.length - actionable.length;
    if (skipped > 0) {
      this.logger.log(
        `[PENDING][${traceId}] Skipped ${skipped} invitation(s) without active KeyPackage`,
      );
    }
    this.logger.log(
      `[PENDING][${traceId}] DONE groups=${myGroupIds.length} invitations=${actionable.length}`,
    );
    return actionable;
  }

  /**
   * Returns all device-group memberships for a specific device (so the device
   * knows which groups it's `pending` or `active` in).
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/device-memberships/:userId/:deviceId')
  async getDeviceMemberships(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot list another user's device memberships",
    );
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    this.logger.log(
      `[DEVICE_MEMBERSHIPS] user=${safeUserId} device=${safeDeviceId} count=${memberships.length} statuses=${memberships.map((m) => `${m.groupId}:${m.status}`).join(',')}`,
    );
    return memberships;
  }

  /**
   * Update the status of a device-group membership.
   * Valid states: `pending` (Welcome not yet processed) or `active` (Welcome received and in sync).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/invitations/status')
  async updateInvitationStatus(
    @Body()
    body: {
      deviceId: string;
      userId: string;
      groupId: string;
      status: 'pending' | 'active';
    },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');
    // Authorization: a device marks ITSELF active (owns userId), OR any active member of the
    // group vouches that another user's device is already in the shared MLS tree - the same
    // trust model as kick-stale-device. Group members can already invite/kick devices, so
    // confirming a fulfilled invitation adds no new authority; it only stops
    // getPendingInvitations from re-serving a device provably already in the tree every sync.
    const caller = headerUserId
      ? sanitizeQueryValue(headerUserId, 'x-user-id')
      : undefined;
    if (headerGlobalAdmin !== 'true' && caller && caller !== safeUserId) {
      await this.assertCallerIsGroupMember(
        caller,
        safeGroupId,
        headerGlobalAdmin,
      );
    }

    const validStatuses = ['pending', 'active'];
    if (!validStatuses.includes(body.status)) {
      throw new BadRequestException(
        `status must be one of: ${validStatuses.join(', ')}`,
      );
    }

    let membership = await this.deviceGroupRepo.findOne({
      where: { deviceId: safeDeviceId, groupId: safeGroupId },
    });

    if (!membership) {
      membership = this.deviceGroupRepo.create({
        deviceId: safeDeviceId,
        userId: safeUserId,
        groupId: safeGroupId,
        status: body.status,
      });
    } else {
      membership.status = body.status;
    }

    await this.deviceGroupRepo.save(membership);
    this.logger.log(
      `[INVITATION_STATUS] device=${safeDeviceId} user=${safeUserId} group=${safeGroupId} newStatus=${body.status}`,
    );
    return { status: membership.status };
  }

  /**
   * Reset all device-group memberships of a user in a group to `pending`.
   * Called by a client after it has performed the MLS remove commit for a user.
   * All devices of that user will be re-invited on the next sync cycle.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/kick-stale-user')
  async kickStaleUser(
    @Body() body: { userId: string; groupId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    if (!headerUserId)
      throw new BadRequestException('Missing X-User-Id header');
    const callerUserId = sanitizeQueryValue(headerUserId, 'userId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');
    await this.assertCallerIsGroupMember(
      callerUserId,
      safeGroupId,
      headerGlobalAdmin,
    );

    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, groupId: safeGroupId },
    });

    for (const m of memberships) {
      m.status = 'pending';
    }

    if (memberships.length > 0) {
      await this.deviceGroupRepo.save(memberships);
      this.logger.log(
        `[KICK] Reset ${memberships.length} device(s) of user ${safeUserId} in group ${safeGroupId} to pending`,
      );
    }

    return {
      status: 'kicked',
      affected: memberships.length,
      devices: memberships.map((m) => ({
        deviceId: m.deviceId,
        groupId: m.groupId,
      })),
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/kick-stale-device')
  /** Resets a single device membership in a group back to `pending` so it can be re-invited. */
  async kickStaleDevice(
    @Body() body: { deviceId: string; userId: string; groupId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    if (!headerUserId)
      throw new BadRequestException('Missing X-User-Id header');
    const callerUserId = sanitizeQueryValue(headerUserId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');
    await this.assertCallerIsGroupMember(
      callerUserId,
      safeGroupId,
      headerGlobalAdmin,
    );

    const membership = await this.deviceGroupRepo.findOne({
      where: {
        deviceId: safeDeviceId,
        userId: safeUserId,
        groupId: safeGroupId,
      },
    });

    if (!membership) {
      return { status: 'not_found', affected: 0 };
    }

    membership.status = 'pending';
    await this.deviceGroupRepo.save(membership);

    await this.redis.srem(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );

    this.logger.log(
      `[KICK] Reset device ${safeDeviceId} of user ${safeUserId} in group ${safeGroupId} to pending`,
    );

    return { status: 'kicked', affected: 1, deviceId: safeDeviceId };
  }

  /**
   * Delete a specific device-group membership (e.g. when removing a device).
   * Also deletes ALL memberships for the device if no groupId is provided.
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls/device-memberships/:userId/:deviceId/:groupId')
  async deleteDeviceMembership(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Param('groupId') groupId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');

    const result = await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
      groupId: safeGroupId,
    });

    // Keep Redis message routing in sync with membership deletion.
    await this.redis.srem(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );

    this.logger.log(
      `[DEL_MEMBERSHIP] user=${safeUserId} device=${safeDeviceId} group=${safeGroupId} affected=${result.affected ?? 0}`,
    );
    return { status: 'deleted', affected: result.affected ?? 0 };
  }

  /**
   * Forces a device out of a group (unrecoverable MLS state or reboot requested).
   * Deletes the DeviceGroupMembership and removes the device from the Redis routing set
   * so the server stops sending messages for this group to it.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/force_leave')
  async forceLeave(
    @Param('groupId') groupId: string,
    @Body() body: { deviceId: string },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(headerUserId ?? '', 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId ?? '', 'deviceId');

    const result = await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
      groupId: safeGroupId,
    });

    await this.redis.srem(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );

    this.logger.log(
      `[FORCE_LEAVE] user=${safeUserId} device=${safeDeviceId} group=${safeGroupId} affected=${result.affected ?? 0}`,
    );
    return { ok: true, affected: result.affected ?? 0 };
  }

  /**
   * Delete ALL device-group memberships for a specific device.
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls/device-memberships/:userId/:deviceId')
  async deleteAllDeviceMemberships(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // Capture affected groups before delete so we can clean Redis routing sets.
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: { groupId: true },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    const result = await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    const memberKey = `${safeUserId}:${safeDeviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    this.logger.log(
      `[DEL_ALL_MEMBERSHIPS] user=${safeUserId} device=${safeDeviceId} affected=${result.affected ?? 0} redisGroupsCleaned=${groupIds.length}`,
    );
    return { status: 'deleted', affected: result.affected ?? 0 };
  }
}
