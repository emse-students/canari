import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { resolveGroupInvitePreview } from '../utils/group-invite';
import { MessagingService } from '../services/messaging.service';

/**
 * Internal-only endpoints - called by other services via Docker-internal networking.
 * NOT exposed through Nginx.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
    @InjectRepository(KeyPackage)
    private readonly keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private readonly otpRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(DeviceGroupMembership)
    private readonly deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(QueuedMessage)
    private readonly queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(PinVerifier)
    private readonly pinVerifierRepo: Repository<PinVerifier>,
    @InjectRepository(RevokedDevice)
    private readonly revokedDeviceRepo: Repository<RevokedDevice>,
    @InjectRepository(GroupInvite)
    private readonly groupInviteRepo: Repository<GroupInvite>,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    private readonly messagingService: MessagingService
  ) {}

  /**
   * Refuses anything that is not a service-to-service call. Constant-time, and an unset
   * INTERNAL_SECRET matches nothing - so a misconfigured deployment fails closed.
   */
  private assertInternalSecret(headerSecret: string | undefined): void {
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
  }

  /**
   * Session-free group invite preview, called by the web SSR process when it renders the Open
   * Graph head of `/g/join/:token`. The user-facing route is behind `HeaderAuthGuard` and an
   * unfurler has no session; both call one `resolveGroupInvitePreview`, so what a shared invite
   * link discloses is decided in a single place.
   */
  @Get('group-invites/:token')
  async groupInvitePreview(
    @Param('token') token: string,
    @Headers('x-internal-secret') headerSecret?: string
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(`internal group invite preview token=${token.slice(0, 8)}`);
    return resolveGroupInvitePreview(this.groupInviteRepo, this.groupRepo, token);
  }

  /**
   * The one entry point every other service uses to push to a user (community channel messages
   * and their silent `channel_read` frames from `channel.service.ts`, posts and form reminders
   * from `push.service.ts`).
   *
   * IT DELEGATES RATHER THAN SENDING. It used to hold its own `getMessaging().send()` loop -
   * token lookup, invalid-token cleanup and all - which was the same send as
   * {@link MessagingService.sendPushToUser} MINUS the `apns` block. That difference is not a
   * detail: FCM turns a message with no `apns` block into a data-only push, which iOS never
   * surfaces and which never triggers the Notification Service Extension. So EVERY push this
   * endpoint carried - every salon message, every post, every form reminder, every cross-device
   * read frame - was silently dropped on the floor by every iPhone, while the same payload
   * notified Android correctly and the endpoint reported `sent`.
   *
   * Two copies of a send are two contracts, and only one of them was maintained.
   */
  @Post('push/notify')
  async notifyUser(
    @Headers('x-internal-secret') headerSecret: string,
    @Body()
    body: {
      userId: string;
      title: string;
      body: string;
      data?: Record<string, string>;
    }
  ) {
    this.assertInternalSecret(headerSecret);

    const { userId, title, body: notifBody, data = {} } = body;
    if (!userId || !title) {
      this.logger.warn(
        `[INTERNAL_PUSH] refused: userId=${userId ? 'set' : 'missing'} title=${title ? 'set' : 'missing'}`
      );
      return { sent: 0, failed: 0 };
    }

    const result = await this.messagingService.sendPushToUser(userId, title, notifBody, data);
    this.logger.log(
      `[INTERNAL_PUSH] type=${data.type ?? 'none'} user=${userId} sent=${result.sent} failed=${result.failed}`
    );
    return result;
  }

  /**
   * Creates - or returns, unchanged - the Graine key-distribution group of a community.
   *
   * WHY THE COMMUNITY'S ID AND NOT A NAME: `dm_groups."distributionWorkspaceId"` carries a partial
   * unique index, so "exactly one distribution group per community" is a fact the DATABASE holds.
   * A second concurrent creation loses the insert instead of producing two groups each owning half
   * the seeds - which is why the conflict is re-read rather than reported.
   *
   * WHAT IT DELIBERATELY DOES NOT WRITE: no `dm_group_members` row and no `DeviceGroupMembership`.
   * The group is entered by external commit, and its roster is the community's, held by
   * social-service. Both absences are load-bearing - see the WP-20 audit in
   * `docs/wiki/protocols/channel-encryption.md`, whose whole enumeration rests on them.
   *
   * The MLS group itself is NOT created here and cannot be: the server holds no MLS state and can
   * derive none. This is the row; a client initialises the group and publishes its GroupInfo
   * through {@link publishDistributionGroupInfo}.
   */
  @Post('mls/distribution-groups')
  async createDistributionGroup(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { workspaceId?: string }
  ): Promise<{ groupId: string; created: boolean }> {
    this.assertInternalSecret(headerSecret);
    const workspaceId = (body?.workspaceId ?? '').trim();
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }

    const existing = await this.groupRepo.findOne({
      where: { distributionWorkspaceId: workspaceId },
    });
    if (existing) {
      this.logger.log(`[DISTRIBUTION_GROUP] reuse workspace=${workspaceId} group=${existing.id}`);
      return { groupId: existing.id, created: false };
    }

    try {
      const created = await this.groupRepo.save(
        this.groupRepo.create({ isGroup: true, distributionWorkspaceId: workspaceId })
      );
      this.logger.log(`[DISTRIBUTION_GROUP] created workspace=${workspaceId} group=${created.id}`);
      return { groupId: created.id, created: true };
    } catch (e) {
      // The unique index fired: another request created it between the SELECT and the INSERT. The
      // winner's row is the answer, so re-read rather than surfacing a conflict the caller cannot
      // act on. Anything else is a real failure and must propagate.
      const raced = await this.groupRepo.findOne({
        where: { distributionWorkspaceId: workspaceId },
      });
      if (!raced) throw e;
      this.logger.warn(
        `[DISTRIBUTION_GROUP] concurrent creation workspace=${workspaceId} group=${raced.id} - the index held`
      );
      return { groupId: raced.id, created: false };
    }
  }

  /**
   * The community's distribution group and the latest GroupInfo published on it, so a caller that
   * has already established community membership can hand a client what it needs to external-join.
   *
   * `groupInfo` is null until the first client has initialised the MLS group - a real state, not an
   * error: the community exists and nobody has opened it yet.
   */
  @Get('mls/distribution-groups/:workspaceId')
  async getDistributionGroup(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-secret') headerSecret: string
  ): Promise<{ groupId: string; groupInfo: string | null; baseEpoch: number | null } | null> {
    this.assertInternalSecret(headerSecret);

    const group = await this.groupRepo.findOne({
      where: { distributionWorkspaceId: workspaceId },
    });
    if (!group) {
      this.logger.warn(`[DISTRIBUTION_GROUP] absent workspace=${workspaceId}`);
      return null;
    }

    const info = await this.messagingService.readGroupInfo(group.id);
    this.logger.log(
      `[DISTRIBUTION_GROUP] read workspace=${workspaceId} group=${group.id} published=${!!info}`
    );
    return {
      groupId: group.id,
      groupInfo: info?.groupInfo ?? null,
      baseEpoch: info?.baseEpoch ?? null,
    };
  }

  /**
   * Publishes the GroupInfo of a community's distribution group, after its committer's own service
   * has established that they belong to the community.
   *
   * The public route (`POST /mls/group-info/:groupId`) cannot serve this: it gates on a
   * `dm_group_members` row, and a distribution group has none by construction. The monotonic rule
   * is not duplicated here - both routes land on the same `putGroupInfo`.
   */
  @Post('mls/distribution-groups/:workspaceId/group-info')
  async publishDistributionGroupInfo(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { groupInfo?: string; baseEpoch?: number }
  ): Promise<{ stored: boolean }> {
    this.assertInternalSecret(headerSecret);
    if (typeof body?.groupInfo !== 'string' || !Number.isFinite(body?.baseEpoch)) {
      throw new BadRequestException('groupInfo (base64) and baseEpoch are required');
    }

    const group = await this.groupRepo.findOne({
      where: { distributionWorkspaceId: workspaceId },
    });
    if (!group) {
      throw new BadRequestException(`No distribution group for community ${workspaceId}`);
    }

    const result = await this.messagingService.putGroupInfo(
      group.id,
      body.groupInfo,
      body.baseEpoch as number
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] group-info workspace=${workspaceId} group=${group.id} epoch=${body.baseEpoch} stored=${result.stored}`
    );
    return result;
  }

  /**
   * Tombstones the distribution group of a community that is going away. Deliberately the same
   * soft delete every other group dies of, so `cleanupSoftDeletedGroups` reaps it on the same
   * schedule and no second lifecycle exists.
   */
  @Delete('mls/distribution-groups/:workspaceId')
  async deleteDistributionGroup(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-secret') headerSecret: string
  ): Promise<{ deleted: boolean }> {
    this.assertInternalSecret(headerSecret);

    const group = await this.groupRepo.findOne({
      where: { distributionWorkspaceId: workspaceId },
    });
    if (!group) {
      // Not an error: a community created before Graine, or one whose group was already reaped.
      this.logger.log(`[DISTRIBUTION_GROUP] delete workspace=${workspaceId} - nothing to delete`);
      return { deleted: false };
    }

    await this.groupRepo.update({ id: group.id }, { deletedAt: new Date() });
    this.logger.log(`[DISTRIBUTION_GROUP] deleted workspace=${workspaceId} group=${group.id}`);
    return { deleted: true };
  }

  /**
   * Deletes all MLS/device/conversation data for the given user.
   *
   * - 1-on-1 DMs (isGroup=false): group is fully deleted (soft-delete + hard-delete all data).
   * - Multi-member groups (isGroup=true): user is removed from the group; the group itself
   *   and other members' data are preserved.
   * - Redis group:members sets are cleaned for both cases.
   * - History streams (history:{groupId}) are deleted only for DMs.
   *
   * Called by core-service during account deletion - not exposed through Nginx.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    this.assertInternalSecret(headerSecret);

    this.logger.log(`[INTERNAL_DELETE] starting user=${userId}`);

    // Resolve all groups this user belongs to before deleting membership rows
    const memberships = await this.groupMemberRepo.find({ where: { userId } });
    const groupIds = memberships.map((m) => m.groupId);

    if (groupIds.length > 0) {
      const groups = await this.groupRepo.findBy({ id: In(groupIds) });

      const dmGroups = groups.filter((g) => !g.isGroup);
      const multiGroups = groups.filter((g) => g.isGroup);

      // ── DMs: delete the entire group ─────────────────────────────────────
      await Promise.all(
        dmGroups.map(async (g) => {
          // Soft-delete the group row (tombstone so devices can detect deletion)
          await this.groupRepo.update({ id: g.id }, { deletedAt: new Date() });
          // Hard-delete all operational data for the DM
          await Promise.all([
            this.groupMemberRepo.delete({ groupId: g.id }),
            this.deviceGroupRepo.delete({ groupId: g.id }),
            this.queuedMessageRepo.delete({ groupId: g.id }),
            this.redis.del(`group:members:${g.id}`),
            this.redis.del(`history:${g.id}`),
          ]);
          this.logger.log(`[INTERNAL_DELETE] DM deleted groupId=${g.id}`);
        })
      );

      // ── Multi-member groups: remove user from Redis membership sets ───────
      const deviceIds = await this.keyPackageRepo
        .find({ where: { userId }, select: { deviceId: true } })
        .then((kps) => kps.map((kp) => kp.deviceId));

      await Promise.all(
        multiGroups.map(async (g) => {
          if (deviceIds.length > 0) {
            const members = deviceIds.map((d) => `${userId}:${d}`);
            await this.redis.srem(`group:members:${g.id}`, ...members);
          }
          this.logger.log(`[INTERNAL_DELETE] removed from group groupId=${g.id}`);
        })
      );
    }

    // ── User's own records ────────────────────────────────────────────────
    await Promise.all([
      this.keyPackageRepo.delete({ userId }),
      this.otpRepo.delete({ userId }),
      // DM groupMember rows already deleted above; this cleans multi-group rows
      this.groupMemberRepo.delete({ userId }),
      this.deviceGroupRepo.delete({ userId }),
      this.queuedMessageRepo.delete({ recipientId: userId }),
      this.pushTokenRepo.delete({ userId }),
      this.pinVerifierRepo.delete({ userId }),
      this.revokedDeviceRepo.delete({ userId }),
    ]);

    this.logger.log(`[INTERNAL_DELETE] done user=${userId}`);
    return { ok: true };
  }
}
