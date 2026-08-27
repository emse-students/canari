import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Inject,
  BadRequestException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  deleteGroupOwnedRows,
  deleteGroupRedisKeys,
  totalGroupOwnedRows,
} from '../utils/group-purge';
import { sanitizeQueryValue } from '../utils/sanitize';

/** MLS group lifecycle: create, read, rename, delete, and epoch management. */
@Controller()
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);

  constructor(
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups')
  /** Creates a new MLS group record on the server. */
  async createGroup(
    @Body()
    body: { name: string; createdBy: string; isGroup?: boolean; creatorDeviceId?: string }
  ) {
    const traceId = this.makeTraceId('create-grp');
    const groupId = crypto.randomUUID();
    this.logger.log(
      `[CREATE_GROUP][${traceId}] name="${body.name}" createdBy=${body.createdBy} isGroup=${body.isGroup ?? true} creatorDevice=${body.creatorDeviceId ?? 'none'} groupId=${groupId}`
    );
    const newGroup = this.groupRepo.create({
      id: groupId,
      name: body.name,
      isGroup: body.isGroup ?? true,
    });
    await this.groupRepo.save(newGroup);

    // Mark the creator's device as active (they created the group locally, no Welcome needed)
    if (body.createdBy && body.creatorDeviceId) {
      const creatorMembership = this.deviceGroupRepo.create({
        userId: body.createdBy,
        deviceId: body.creatorDeviceId,
        groupId,
        status: 'active' as const,
      });
      await this.deviceGroupRepo.save(creatorMembership);
      this.logger.log(`[CREATE_GROUP][${traceId}] creator membership set to active`);
      await this.redis.sadd(
        `group:members:${groupId}`,
        `${body.createdBy}:${body.creatorDeviceId}`
      );
    }

    this.logger.log(`[CREATE_GROUP][${traceId}] DONE groupId=${groupId}`);
    return {
      groupId,
      name: body.name,
      createdBy: body.createdBy,
      isGroup: newGroup.isGroup,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId')
  /** Retrieves metadata for a single group by its ID. */
  async getGroup(@Param('groupId') groupId: string) {
    const g = await this.groupRepo.findOne({ where: { id: groupId } });
    this.logger.log(`[GET_GROUP] groupId=${groupId} found=${!!g}`);
    return g ? { ...g, groupId: g.id } : null;
  }

  @UseGuards(HeaderAuthGuard)
  @Patch('mls/groups/:groupId')
  /** Renames a group. */
  async renameGroup(@Param('groupId') groupId: string, @Body() body: { name: string }) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name is required');
    }
    await this.groupRepo.update({ id: safeGroupId }, { name: body.name.trim() });
    this.logger.log(`[RENAME_GROUP] group=${safeGroupId} newName="${body.name.trim()}"`);
    return { status: 'renamed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Patch('mls/groups/:groupId/image')
  /** Sets or clears the group's avatar (media-service id). Pass mediaId=null to remove the photo. */
  async setGroupImage(@Param('groupId') groupId: string, @Body() body: { mediaId: string | null }) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const mediaId = body?.mediaId ?? null;
    if (mediaId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId format');
    }
    await this.groupRepo.update({ id: safeGroupId }, { imageMediaId: mediaId });
    this.logger.log(`[SET_GROUP_IMAGE] group=${safeGroupId} mediaId=${mediaId ?? 'null'}`);
    return { status: 'updated', imageMediaId: mediaId };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId')
  /**
   * Soft-deletes a group, then hard-deletes everything it owns.
   *
   * THE TOMBSTONE AND THE RESIDUE GO IN ONE UNIT OF WORK, through the allowlist that DEFINES what a
   * group owns ({@link deleteGroupOwnedRows}). This route used to name four tables by hand and left
   * `mls_commit_log`, `mls_group_info`, `group_invites` and `user_dismissed_groups` behind - and
   * because the row deliberately SURVIVES as a tombstone, the orphan sweep could never collect them:
   * it only finds groups with no row at all, so what a soft-delete leaks is permanent until the
   * 90-day reaper. A hand-written list here is a second definition of ownership that will drift from
   * the first one, and it did.
   *
   * The Redis keys go after the commit, for the reason {@link deleteGroupRedisKeys} gives.
   */
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');

    const counts = await this.groupRepo.manager.transaction(async (manager) => {
      await manager.getRepository(Group).update({ id: safeGroupId }, { deletedAt: new Date() });
      // SOFT: the tombstone stays, so the per-user dismissal markers stay with it - see
      // `deleteGroupOwnedRows`. They are facts about people, not about this group.
      return deleteGroupOwnedRows(manager, [safeGroupId], { groupRowSurvives: true });
    });
    await deleteGroupRedisKeys(this.redis, [safeGroupId]);

    this.logger.log(
      `[DELETE_GROUP] ${safeGroupId.slice(0, 8)}… soft-deleted, ` +
        `${totalGroupOwnedRows(counts)} row(s) purged: ${JSON.stringify(counts)}`
    );
    return { status: 'deleted' };
  }
}
