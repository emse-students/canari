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
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  deleteGroupOwnedRows,
  deleteGroupRedisKeys,
  totalGroupOwnedRows,
} from '../utils/group-purge';
import { sanitizeIdentityValue, sanitizeQueryValue } from '../utils/sanitize';
import { MessagingService } from '../services/messaging.service';

/** MLS group lifecycle: create, read, rename, delete, and epoch management. */
@Controller()
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);

  constructor(
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(MlsGroupInfo)
    private groupInfoRepo: Repository<MlsGroupInfo>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly messagingService: MessagingService
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups')
  /**
   * Creates a new MLS group record on the server, and enrols the creator's device in it.
   *
   * **THE ENROLMENT IS A `pending -> active` TRANSITION LIKE ANY OTHER, AND IT USED TO BE THE ONE
   * THAT ASKED NOTHING.** It wrote `status: 'active'` straight to the repository: no addressability
   * gate, so a revoked or key-package-less device enrolled itself in a group it had just made
   * (WP-GHOST-1, which the other two paths refuse); and no identity check, so the client's
   * unresolved-identity placeholder could be stored as a real member - the 2026-08-27 defect
   * `updateInvitationStatus` was hardened against, reachable here the whole time.
   *
   * **The gate runs BEFORE the group row is written.** A refusal after it would leave a group with
   * no members at all, which is an orphan someone else has to purge; refusing first leaves nothing
   * behind. The endpoint can therefore answer 400, which is what the status endpoint already
   * answers for the same condition.
   *
   * `redeliverMissed: false`: the group was created this instant, so there is no pending window and
   * nothing was missed.
   */
  async createGroup(
    @Body()
    body: { name: string; createdBy: string; isGroup?: boolean; creatorDeviceId?: string }
  ) {
    const traceId = this.makeTraceId('create-grp');
    // A group with no creator device enrols nobody - there is no membership to gate, and the
    // creator reaches it through the ordinary invitation path like any other device.
    const enrolling = Boolean(body.createdBy && body.creatorDeviceId);
    const safeCreatorId = enrolling ? sanitizeIdentityValue(body.createdBy, 'createdBy') : '';
    const safeCreatorDeviceId = enrolling
      ? sanitizeIdentityValue(body.creatorDeviceId, 'creatorDeviceId')
      : '';

    if (enrolling) {
      const addressable = await this.messagingService.deviceAddressability(
        safeCreatorId,
        safeCreatorDeviceId
      );
      if (!addressable.ok) {
        this.logger.warn(
          `[CREATE_GROUP][${traceId}] REFUSED device=${safeCreatorId}:${safeCreatorDeviceId}` +
            ` reason=${addressable.reason} - no group row was written`
        );
        throw new BadRequestException(`Device is not addressable: ${addressable.reason}`);
      }
    }

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

    // The creator made the group locally, so no Welcome is owed - but the row and the routing set
    // are written by the ONE writer, so they cannot disagree with the other two doors again.
    if (enrolling) {
      const outcome = await this.messagingService.activateDeviceMembership(
        safeCreatorId,
        safeCreatorDeviceId,
        groupId,
        { redeliverMissed: false, tag: 'CREATE_GROUP' }
      );
      // The gate above already answered this, so a refusal here means the device was revoked in
      // the microseconds since - a real race, and the group it just made is now memberless.
      if (!outcome.ok) {
        throw new BadRequestException(`Device is not addressable: ${outcome.reason}`);
      }
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
  /**
   * Retrieves metadata for a single group by its ID.
   *
   * **`baseEpoch` TRAVELS WITH IT, BECAUSE THIS IS THE CALL A LOCKED-OUT DEVICE ALREADY MAKES.**
   * `activeEpoch` is a column of the row and was already on the wire; the published external-join
   * base lives in `mls_group_info` and was not, so a device refused `stale_base` had no way to see
   * the two numbers converge except by attempting the join again. `GET /mls/users/:id/groups`
   * carries both for the same reason and says why - the pair IS the durable record of "a republish
   * is owed", and nothing else needs to store it.
   *
   * Measured on production 2026-09-12: one device ran the whole recovery cycle - four calls - once
   * a minute against group `4f87267a` for at least twenty-seven consecutive minutes, and every
   * pass could have ended on this one read. `null` means no base has ever been published, which is
   * NOT staleness: nothing has been lost, and a joiner asks for a Welcome instead.
   */
  async getGroup(@Param('groupId') groupId: string) {
    const g = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!g) {
      this.logger.log(`[GET_GROUP] groupId=${groupId} found=false`);
      return null;
    }
    const base = await this.groupInfoRepo.findOne({
      select: { groupId: true, baseEpoch: true },
      where: { groupId: g.id },
    });
    this.logger.log(`[GET_GROUP] groupId=${groupId} found=true`);
    return { ...g, groupId: g.id, baseEpoch: base?.baseEpoch ?? null };
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
