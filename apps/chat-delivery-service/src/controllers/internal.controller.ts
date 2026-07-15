import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
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
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis
  ) {}

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
    // Constant-time comparison to prevent timing attacks on the shared secret.
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }

    if (getApps().length === 0) {
      this.logger.warn('[INTERNAL_PUSH] Firebase not initialized - skipping');
      return { sent: 0, failed: 0 };
    }

    const { userId, title, body: notifBody, data = {} } = body;
    if (!userId || !title) return { sent: 0, failed: 0 };

    const tokens = await this.pushTokenRepo.find({ where: { userId } });
    let sent = 0;
    let failed = 0;

    for (const pt of tokens) {
      try {
        // Data-only -> onMessageReceived() fires even in the background.
        // Kotlin reads data["type"] to pick the channel (canari_social / canari_forms)
        // and build the deepLink (deepLink, postId, or formId depending on type).
        await getMessaging().send({
          token: pt.token,
          data: { ...data, title, body: notifBody },
          android: { priority: 'high' },
        });
        sent++;
      } catch (e) {
        failed++;
        const code = typeof e === 'object' && e && 'code' in e ? String((e as any).code) : '';
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          await this.pushTokenRepo.delete({ id: pt.id }).catch(() => {});
        }
        this.logger.warn(
          `[INTERNAL_PUSH] Failed user=${userId} device=${pt.deviceId}: ${String(e)}`
        );
      }
    }

    this.logger.log(`[INTERNAL_PUSH] user=${userId} sent=${sent} failed=${failed}`);
    return { sent, failed };
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
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }

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
