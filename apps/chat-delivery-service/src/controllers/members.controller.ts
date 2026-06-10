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
import { Repository, MoreThanOrEqual, DataSource, In } from 'typeorm';
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

  /**
   * Loads group rows for `seedIds` and follows successor links until all chain
   * nodes are in memory (max 10 hops per seed).
   */
  private async loadGroupsWithSuccessorChains(
    seedIds: string[],
  ): Promise<Map<string, Group>> {
    const byId = new Map<string, Group>();
    let frontier = new Set(seedIds);

    for (let hop = 0; hop < 10 && frontier.size > 0; hop++) {
      const ids = [...frontier].filter((id) => !byId.has(id));
      frontier = new Set();
      if (ids.length === 0) break;

      const batch = await this.groupRepo.find({ where: { id: In(ids) } });
      for (const g of batch) {
        byId.set(g.id, g);
        if (g.successorId && !byId.has(g.successorId)) {
          frontier.add(g.successorId);
        }
      }
    }

    return byId;
  }

  /** Resolves a group id to the active terminal of its successor lineage. */
  private resolveActiveTerminal(
    groupId: string,
    byId: Map<string, Group>,
  ): Group | null {
    const visited = new Set<string>();
    let current: string | null = groupId;

    while (current && !visited.has(current)) {
      visited.add(current);
      const g = byId.get(current);
      if (!g) return null;
      if (!g.deletedAt) return g;
      current = g.successorId ?? null;
    }

    return null;
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
    const byId = await this.loadGroupsWithSuccessorChains(groupIds);
    const activeById = new Map<string, Group>();
    for (const id of groupIds) {
      const terminal = this.resolveActiveTerminal(id, byId);
      if (terminal) activeById.set(terminal.id, terminal);
    }
    const activeGroups = [...activeById.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    this.logger.log(
      `[USER_GROUPS] user=${safeUserId} groups=${activeGroups.length} ids=${activeGroups.map((g) => g.id).join(',')}`,
    );
    return activeGroups.map((g) => ({
      groupId: g.id,
      name: g.name,
      isGroup: g.isGroup,
      successorId: g.successorId ?? null,
      deletedAt: g.deletedAt ?? null,
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

    // NB: NOT added to group:members Redis here - devices enter the routing
    // set only when their Welcome is sent (sendWelcome sets status to active).
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length}`,
    );
    return { status: 'added' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/user-members')
  /** Returns user-level membership from dm_group_members (no device-status filter). */
  async getGroupUserMembers(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const rows = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: ['userId'],
    });
    this.logger.log(
      `[GET_USER_MEMBERS] group=${safeGroupId} count=${rows.length}`,
    );
    return rows.map((r) => ({ userId: r.userId }));
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
   * Do NOT use this to determine which users to invite into a successor group.
   * A group can have zero active device entries even though users still belong to it
   * (e.g. after a device fresh-start clears all DeviceGroupMembership rows). Use
   * `GET mls/groups/:groupId/user-members` (dm_group_members) for that purpose.
   */
  async getGroupMembers(@Param('groupId') groupId: string) {
    const rows = await this.deviceGroupRepo.find({
      where: { groupId, status: 'active' as const },
      select: ['userId', 'deviceId'],
    });
    this.logger.log(`[GET_MEMBERS] group=${groupId} count=${rows.length}`);
    return rows;
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
