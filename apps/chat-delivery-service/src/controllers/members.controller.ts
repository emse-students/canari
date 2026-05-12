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
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue, assertCallerOwnsUserId } from '../utils/sanitize';

/** Group membership management: add/remove members, list members, list user groups. */
@Controller()
export class MembersController {
  private readonly logger = new Logger(MembersController.name);

  constructor(
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/users/:userId/groups')
  /** Lists all groups a user belongs to. */
  async getUserGroups(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot list another user's groups",
    );
    const memberships = await this.groupMemberRepo.find({
      where: { userId: safeUserId },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    if (groupIds.length === 0) {
      this.logger.log(`[USER_GROUPS] user=${safeUserId} groups=0`);
      return [];
    }
    const groups = await this.groupRepo.findByIds(groupIds);
    this.logger.log(
      `[USER_GROUPS] user=${safeUserId} groups=${groups.length} ids=${groups.map((g) => g.id).join(',')}`,
    );
    return groups.map((g) => ({
      groupId: g.id,
      name: g.name,
      isGroup: g.isGroup,
    }));
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/members')
  /** Adds a member to a group and registers their device-group membership as pending. */
  async addGroupMember(
    @Param('groupId') groupId: string,
    @Body() body: { userId: string },
  ) {
    const traceId = this.makeTraceId('add-member');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.logger.log(
      `[ADD_MEMBER][${traceId}] START group=${safeGroupId} user=${safeUserId}`,
    );

    // Upsert atomique : INSERT ... ON CONFLICT DO UPDATE évite la race findOne+save.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const userDevices = await this.keyPackageRepo.find({
      where: { userId: safeUserId, createdAt: MoreThanOrEqual(cutoff) },
    });

    await this.dataSource.transaction(async (manager) => {
      // Upsert GroupMember : met à jour joinedAt si déjà présent
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

      // Upsert DeviceGroupMembership pour chaque appareil actif : ignore si déjà présent
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

    // NB: NOT added to group:members Redis here — devices only enter the routing
    // set once welcome_sent so pre-welcome devices never receive group messages.
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length}`,
    );
    return { status: 'added' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/members')
  /** Lists all members of a group. */
  async getGroupMembers(@Param('groupId') groupId: string) {
    const g = await this.groupMemberRepo.find({ where: { groupId } });
    this.logger.log(`[GET_MEMBERS] group=${groupId} count=${g.length}`);
    return g;
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId/members/:userId')
  /** Removes a user from a group server-side (deletes their GroupMember record). */
  async removeGroupMember(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');

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
      `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} redisRemoved=${toRemove.length} deviceMembershipsDeleted=${deviceMembershipDelete.affected ?? 0}`,
    );
    return { status: 'removed' };
  }
}
