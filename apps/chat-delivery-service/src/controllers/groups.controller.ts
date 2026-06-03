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
  ConflictException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue } from '../utils/sanitize';

/** MLS group lifecycle: create, read, rename, delete, and epoch management. */
@Controller()
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);

  constructor(
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups')
  /** Creates a new MLS group record on the server. */
  async createGroup(
    @Body()
    body: {
      name: string;
      createdBy: string;
      isGroup?: boolean;
      creatorDeviceId?: string;
    },
  ) {
    const traceId = this.makeTraceId('create-grp');
    const groupId = uuidv4();
    this.logger.log(
      `[CREATE_GROUP][${traceId}] name="${body.name}" createdBy=${body.createdBy} isGroup=${body.isGroup ?? true} creatorDevice=${body.creatorDeviceId ?? 'none'} groupId=${groupId}`,
    );
    const newGroup = this.groupRepo.create({
      id: groupId,
      name: body.name,
      isGroup: body.isGroup ?? true,
    });
    await this.groupRepo.save(newGroup);

    // Mark the creator's device as welcome_received (they created the group locally)
    if (body.createdBy && body.creatorDeviceId) {
      const creatorMembership = this.deviceGroupRepo.create({
        userId: body.createdBy,
        deviceId: body.creatorDeviceId,
        groupId,
        status: 'active' as const,
        lastEpochSeen: 0,
      });
      await this.deviceGroupRepo.save(creatorMembership);
      this.logger.log(
        `[CREATE_GROUP][${traceId}] creator membership set to welcome_received`,
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
  async renameGroup(
    @Param('groupId') groupId: string,
    @Body() body: { name: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name is required');
    }
    await this.groupRepo.update(
      { id: safeGroupId },
      { name: body.name.trim() },
    );
    this.logger.log(
      `[RENAME_GROUP] group=${safeGroupId} newName="${body.name.trim()}"`,
    );
    return { status: 'renamed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId')
  /** Soft-deletes a group (sets deletedAt) and hard-deletes all operational data.
   *  The group row is kept as a tombstone so devices can detect the deletion. */
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    // Soft-delete: keep the row as a tombstone for recovery routing
    await this.groupRepo.update({ id: safeGroupId }, { deletedAt: new Date() });
    // Hard-delete operational data - no longer needed once the group is gone
    await this.groupMemberRepo.delete({ groupId: safeGroupId });
    await this.deviceGroupRepo.delete({ groupId: safeGroupId });
    await this.queuedMessageRepo.delete({ groupId: safeGroupId });
    await this.redis.del(`group:members:${safeGroupId}`);
    this.logger.log(`[DELETE_GROUP] group=${safeGroupId} (soft-deleted)`);
    return { status: 'deleted' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/successor')
  /** Atomically claims a successor for a dead group (first writer wins).
   *  Returns 200 with claimed=true if this device won the race,
   *  or 409 with claimed=false and the real successorId if another device already claimed it. */
  async claimSuccessor(
    @Param('groupId') groupId: string,
    @Body() body: { successorId: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (!body.successorId || typeof body.successorId !== 'string') {
      throw new BadRequestException('successorId is required');
    }
    // Atomic CAS: only update if no successor has been claimed yet
    const result = await this.groupRepo
      .createQueryBuilder()
      .update(Group)
      .set({ successorId: body.successorId, deletedAt: () => 'NOW()' })
      .where('id = :id AND "successorId" IS NULL', { id: safeGroupId })
      .execute();

    if (result.affected === 0) {
      // Another device won - return the real winner's successorId
      const existing = await this.groupRepo.findOne({
        where: { id: safeGroupId },
      });
      this.logger.log(
        `[CLAIM_SUCCESSOR] group=${safeGroupId} LOST - real successor=${existing?.successorId}`,
      );
      throw new ConflictException({
        claimed: false,
        successorId: existing?.successorId ?? null,
      });
    }

    this.logger.log(
      `[CLAIM_SUCCESSOR] group=${safeGroupId} WON - successor=${body.successorId}`,
    );
    return { claimed: true, successorId: body.successorId };
  }
}
