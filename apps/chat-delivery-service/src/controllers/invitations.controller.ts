import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Inject,
  BadRequestException,
  UseGuards,
  Headers,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue, assertCallerOwnsUserId } from '../utils/sanitize';
import { In } from 'typeorm';

/** Device-group membership management: pending invitations, status updates, kick-stale. */
@Controller()
export class InvitationsController {
  private readonly logger = new Logger(InvitationsController.name);

  constructor(
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
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
    // Utilise In() pour générer un seul prédicat WHERE groupId IN (...) AND status = 'pending'
    // au lieu de N clauses OR (une par groupe), ce qui est nettement plus efficace avec PostgreSQL.
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
      lastEpochSeen?: number;
    },
  ) {
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

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

    if (
      typeof body.lastEpochSeen === 'number' &&
      Number.isFinite(body.lastEpochSeen)
    ) {
      membership.lastEpochSeen = Math.floor(body.lastEpochSeen);
    }

    await this.deviceGroupRepo.save(membership);
    this.logger.log(
      `[INVITATION_STATUS] device=${safeDeviceId} user=${safeUserId} group=${safeGroupId} newStatus=${body.status} epoch=${membership.lastEpochSeen ?? 'n/a'}`,
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
  async kickStaleUser(@Body() body: { userId: string; groupId: string }) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, groupId: safeGroupId },
    });

    for (const m of memberships) {
      m.status = 'pending';
      m.lastEpochSeen = 0;
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
  ) {
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

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
    membership.lastEpochSeen = 0;
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
   * Force la sortie d'un device d'un groupe (état MLS irrécupérable ou reboot demandé).
   * Supprime le DeviceGroupMembership et retire le device du set Redis de routage
   * afin que le serveur cesse de lui envoyer des messages pour ce groupe.
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
      select: ['groupId'],
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
