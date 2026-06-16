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

    // Mark the creator's device as active (they created the group locally, no Welcome needed)
    if (body.createdBy && body.creatorDeviceId) {
      const creatorMembership = this.deviceGroupRepo.create({
        userId: body.createdBy,
        deviceId: body.creatorDeviceId,
        groupId,
        status: 'active' as const,
      });
      await this.deviceGroupRepo.save(creatorMembership);
      this.logger.log(
        `[CREATE_GROUP][${traceId}] creator membership set to active`,
      );
      await this.redis.sadd(
        `group:members:${groupId}`,
        `${body.createdBy}:${body.creatorDeviceId}`,
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
  /**
   * Soft-deletes a group and every successor in its lineage, then hard-deletes
   * all operational data for each.
   *
   * Following the full chain is essential: if the caller holds an old version of
   * the group (before a reboot), deleting only that version leaves the terminal
   * successor alive. On the next sync the delivery service would see the live
   * terminal and trigger a welcome_request, effectively resurrecting the group.
   */
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');

    // Collect the full successor chain (cycle-safe, max 10 hops).
    const toDelete: string[] = [];
    let current: string | null = safeGroupId;
    const visited = new Set<string>();
    while (current && !visited.has(current) && toDelete.length < 10) {
      visited.add(current);
      toDelete.push(current);
      const g = await this.groupRepo.findOne({
        where: { id: current },
        select: ['id', 'successorId'],
      });
      current = g?.successorId ?? null;
    }

    const now = new Date();
    for (const id of toDelete) {
      await this.groupRepo.update({ id }, { deletedAt: now });
      await this.groupMemberRepo.delete({ groupId: id });
      await this.deviceGroupRepo.delete({ groupId: id });
      await this.queuedMessageRepo.delete({ groupId: id });
      await this.redis.del(`group:members:${id}`);
      await this.redis.del(`history:${id}`);
    }

    this.logger.log(
      `[DELETE_GROUP] ${toDelete.length} group(s) soft-deleted: ${toDelete.map((id) => id.slice(0, 8)).join(' → ')}…`,
    );
    return { status: 'deleted' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/successor')
  /** Atomically claims a successor for a dead group (first writer wins).
   *  Returns 200 with claimed=true if this device won the race,
   *  or 409 with claimed=false and the real successorId if another device already claimed it. */
  async claimSuccessor(
    @Param('groupId') groupId: string,
    @Body() body: { successorId: string; claimedByDeviceId?: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (!body.successorId || typeof body.successorId !== 'string') {
      throw new BadRequestException('successorId is required');
    }
    // Diagnostic-only: record which device triggered the reboot. Never gates the CAS.
    const claimedByDeviceId =
      typeof body.claimedByDeviceId === 'string'
        ? body.claimedByDeviceId
        : null;
    // Atomic CAS: only update if no successor has been claimed yet AND the group
    // has not been intentionally deleted. Without the deletedAt guard a reboot
    // racing with deleteGroup would resurrect a group the user just removed.
    const result = await this.groupRepo
      .createQueryBuilder()
      .update(Group)
      .set({
        successorId: body.successorId,
        successorClaimedByDeviceId: claimedByDeviceId,
        deletedAt: () => 'NOW()',
      })
      .where('id = :id AND "successorId" IS NULL AND "deletedAt" IS NULL', {
        id: safeGroupId,
      })
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

    const successorId = body.successorId;

    // Propager les membres (user-level) vers le successeur pour que getUserGroups
    // résolve la lignée correctement.
    //
    // On NE supprime PAS les GroupMember de la source : le device qui reboote doit
    // pouvoir lire " qui appartient au groupe mort " via getGroupUserMembers(deadGroup)
    // pour les inviter dans le successeur (inviteMembers/reboot). Si on les effaçait ici,
    // inviteMembers ne trouverait personne et le successeur resterait vide (split-brain :
    // le créateur seul dans le nouveau groupe, les autres bloqués sur l'ancien).
    // Le tombstone soft-deleted et ses GroupMember sont purgés par le cron
    // cleanupSoftDeletedGroups (90 j) ; getUserGroups/registerDevice ignorent déjà les
    // groupes avec deletedAt, donc aucune résurrection possible entre-temps.
    const members = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
    });
    if (members.length > 0) {
      await this.groupMemberRepo
        .createQueryBuilder()
        .insert()
        .into(GroupMember)
        .values(
          members.map((m) => ({
            groupId: successorId,
            userId: m.userId,
            role: m.role,
          })),
        )
        .orIgnore()
        .execute();
    }

    const deviceMemberships = await this.deviceGroupRepo.find({
      where: { groupId: safeGroupId },
    });
    if (deviceMemberships.length > 0) {
      // Migrate device memberships as `pending`, NOT preserving their old status,
      // and do NOT seed the successor's Redis routing set. The successor was just
      // created, so no device (except its creator, already marked active by
      // createGroup) has processed a Welcome for it - none of these devices have MLS
      // state yet. Copying them as `active` + adding them to routing would deliver
      // ciphertext they cannot decrypt (wasted FCM, spurious welcome_request churn)
      // and would violate the invariant that `active` must mean "has valid MLS state".
      // The reboot winner's inviteMembers (and each device's own welcome_request)
      // promotes them to active + adds them to Redis when they are actually welcomed.
      await this.deviceGroupRepo
        .createQueryBuilder()
        .insert()
        .into(DeviceGroupMembership)
        .values(
          deviceMemberships.map((dm) => ({
            userId: dm.userId,
            deviceId: dm.deviceId,
            groupId: successorId,
            status: 'pending' as const,
          })),
        )
        .orIgnore()
        .execute();
      await this.deviceGroupRepo.delete({ groupId: safeGroupId });
    }
    await this.redis.del(`group:members:${safeGroupId}`);

    this.logger.log(
      `[CLAIM_SUCCESSOR] group=${safeGroupId} WON - successor=${successorId} claimedByDevice=${claimedByDeviceId ?? 'unknown'} members=${members.length} devices=${deviceMemberships.length}`,
    );
    return { claimed: true, successorId };
  }
}
