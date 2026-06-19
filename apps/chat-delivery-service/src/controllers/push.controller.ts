import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  ForbiddenException,
  UseGuards,
  Headers,
  Res,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import Redis from 'ioredis';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
} from '../utils/sanitize';
import { MessagingService } from '../services/messaging.service';

/** Push notification token management and Firebase Cloud Messaging dispatch. */
@Controller()
export class PushController {
  private readonly logger = new Logger(PushController.name);

  constructor(
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly messagingService: MessagingService,
  ) {}

  /**
   * Verifies the PushSecret auth header against the stored secret for the given device.
   * Throws ForbiddenException on failure. Used by all background-service endpoints.
   */
  private async verifyPushSecretAuth(
    authHeader: string,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const secret = authHeader?.startsWith('PushSecret ')
      ? authHeader.slice('PushSecret '.length).trim()
      : null;
    if (!secret) throw new ForbiddenException('PushSecret header required');
    const pt = await this.pushTokenRepo.findOne({
      where: { userId, deviceId },
    });
    const stored = pt?.pushSecret;
    if (!stored) throw new ForbiddenException('Invalid push secret');

    // Reject outright on length mismatch rather than truncating/padding the supplied
    // value to the stored length: padding let any secret sharing the stored prefix
    // authenticate, and truncation let a longer value with the right prefix pass.
    // pushSecret is a fixed-length opaque token, so comparing lengths leaks nothing.
    const expected = Buffer.from(stored, 'utf8');
    const received = Buffer.from(secret, 'utf8');
    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException('Invalid push secret');
    }
  }

  private isTerminalPushTokenError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof rawCode === 'string' ? rawCode : '';

    return (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    );
  }

  /**
   * Register or refresh a push token for a device.
   * Upserts on (userId, deviceId) - one token per device per user.
   */
  @UseGuards(ThrottlerGuard, HeaderAuthGuard)
  @Post('mls/push/register')
  async registerPushToken(
    @Body() body: { token: string; deviceId: string; platform?: string },
    @Headers('x-user-id') userIdRaw: string,
  ) {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    if (typeof body.token !== 'string' || !body.token.trim()) {
      throw new BadRequestException('token is required');
    }
    const token = body.token.trim().slice(0, 500);
    const platform: 'android' | 'ios' =
      body.platform === 'ios' ? 'ios' : 'android';

    // Génère un secret opaque long-lived pour ce device.
    // Retourné UNE SEULE FOIS dans la réponse ; le client l'encrypte dans
    // Android Keystore et l'utilise pour GET /mls/push/fetch-proto.
    const pushSecret = crypto.randomUUID().replace(/-/g, '');

    // Atomic upsert - avoids a race condition where two concurrent requests
    // (e.g. app restart) both find no row then both try to INSERT, with the
    // second hitting the unique(userId, deviceId) constraint.
    await this.pushTokenRepo.upsert(
      { userId, deviceId, token, platform, pushSecret },
      { conflictPaths: ['userId', 'deviceId'] },
    );
    this.logger.log(
      `[PUSH_REGISTER] user=${userId} device=${deviceId} platform=${platform}`,
    );
    // pushSecret retourné UNE SEULE FOIS - le client doit le persister.
    return { status: 'registered', pushSecret };
  }

  /**
   * Endpoint pour le service FCM Android en arrière-plan (app tuée).
   * Auth : Authorization: PushSecret {secret} - pas de JWT (token expiré).
   * Retourne le proto MLS chiffré quand il était trop volumineux pour être
   * inclu inline dans le payload FCM (> 3.5 KB).
   */
  @Get('mls/push/fetch-proto')
  async fetchProtoForPush(
    @Headers('authorization') authHeader: string,
    @Query('messageId') messageIdRaw: string,
    @Query('userId') userIdRaw: string,
    @Query('deviceId') deviceIdRaw: string,
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'userId');
    const deviceId = sanitizeQueryValue(deviceIdRaw ?? '', 'deviceId');
    const messageId = sanitizeQueryValue(messageIdRaw ?? '', 'messageId');

    await this.verifyPushSecretAuth(authHeader, userId, deviceId);

    const queued = await this.queuedMessageRepo.findOne({
      where: { id: messageId, recipientId: userId, deviceId },
    });
    if (!queued) {
      // Message déjà ACKé ou inexistant - retourner vide (pas d'erreur pour éviter retry loops)
      return { proto: '', ratchetTree: '' };
    }
    // ratchetTree is only set on Welcome rows; the background receiver needs it to
    // join the group (it is never included in the FCM data payload, only here).
    return {
      proto: queued.proto ?? queued.content ?? '',
      ratchetTree: queued.ratchetTree ?? '',
    };
  }

  /**
   * Proxy d'avatar pour le background service Android (PushSecret auth, pas de JWT).
   * Appelé par CanariFirebaseMessagingService.fetchAvatar() pour afficher la photo
   * de l'expéditeur dans la large icon de la notification.
   * Auth : Authorization: PushSecret {secret} + ?requesterId=&deviceId= (ownership check)
   */
  @Get('mls/push/avatar/:targetUserId')
  async getAvatarForPush(
    @Headers('authorization') authHeader: string,
    @Query('requesterId') requesterIdRaw: string,
    @Query('deviceId') deviceIdRaw: string,
    @Param('targetUserId') targetUserIdRaw: string,
    @Res() res: Response,
  ) {
    const requesterId = sanitizeQueryValue(requesterIdRaw ?? '', 'requesterId');
    const deviceId = sanitizeQueryValue(deviceIdRaw ?? '', 'deviceId');
    const targetUserId = sanitizeQueryValue(targetUserIdRaw, 'targetUserId');

    await this.verifyPushSecretAuth(authHeader, requesterId, deviceId);

    const coreUrl =
      process.env.CORE_SERVICE_INTERNAL_URL ?? 'http://core-service:3012';
    try {
      const upstream = await fetch(
        `${coreUrl}/api/users/${encodeURIComponent(targetUserId)}/avatar`,
        { signal: AbortSignal.timeout(4_000) },
      );
      if (!upstream.ok) {
        res.status(upstream.status).send();
        return;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res
        .set({
          'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'public, max-age=3600',
        })
        .send(buffer);
    } catch {
      res.status(503).send();
    }
  }

  /**
   * Unregister the push token of a specific device (e.g. on logout).
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls/push/unregister/:deviceId')
  async unregisterPushToken(
    @Param('deviceId') deviceIdRaw: string,
    @Headers('x-user-id') userIdRaw: string,
  ) {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = sanitizeQueryValue(deviceIdRaw, 'deviceId');

    await this.pushTokenRepo.delete({ userId, deviceId });
    this.logger.log(`[PUSH_UNREGISTER] user=${userId} device=${deviceId}`);
    return { status: 'unregistered' };
  }

  // ── Background-service (PushSecret) endpoints ─────────────────────────────

  /**
   * Acquires the distributed add-lock for a group.
   * Called by the Android background service before creating a Welcome package
   * to prevent concurrent epoch forks when multiple devices race to add the same requester.
   * Auth: PushSecret (no JWT - app may be killed).
   */
  @Post('mls/push/acquire-add-lock')
  async acquireAddLockPush(
    @Headers('authorization') authHeader: string,
    @Body() body: { userId: string; deviceId: string; groupId: string },
  ) {
    const userId = sanitizeQueryValue(body.userId ?? '', 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId ?? '', 'deviceId');
    const groupId = sanitizeQueryValue(body.groupId ?? '', 'groupId');
    await this.verifyPushSecretAuth(authHeader, userId, deviceId);

    const lockKey = `mls:addlock:${groupId}`;
    const lockOwner = `${userId}:${deviceId}`;
    const result = await this.redis.set(lockKey, lockOwner, 'EX', 15, 'NX');
    this.logger.log(
      `[ADD_LOCK_PUSH] group=${groupId} owner=${lockOwner} acquired=${result === 'OK'}`,
    );
    return { acquired: result === 'OK' };
  }

  /**
   * Releases the distributed add-lock for a group.
   * Uses a Lua script to atomically verify ownership before deleting.
   * Auth: PushSecret (no JWT).
   */
  @Delete('mls/push/release-add-lock')
  async releaseAddLockPush(
    @Headers('authorization') authHeader: string,
    @Body() body: { userId: string; deviceId: string; groupId: string },
  ) {
    const userId = sanitizeQueryValue(body.userId ?? '', 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId ?? '', 'deviceId');
    const groupId = sanitizeQueryValue(body.groupId ?? '', 'groupId');
    await this.verifyPushSecretAuth(authHeader, userId, deviceId);

    const lockKey = `mls:addlock:${groupId}`;
    const lockOwner = `${userId}:${deviceId}`;
    const released = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      lockOwner,
    );
    this.logger.log(
      `[RELEASE_LOCK_PUSH] group=${groupId} owner=${lockOwner} released=${released === 1}`,
    );
    return { released: released === 1 };
  }

  /**
   * Returns the stored MLS KeyPackage (base64) for a target device.
   * Called by the background service to fetch the requester's key package
   * before creating the Welcome package via Rust JNI.
   * Auth: PushSecret (no JWT).
   */
  @Get('mls/push/key-package')
  async getKeyPackagePush(
    @Headers('authorization') authHeader: string,
    @Query('requesterId') requesterIdRaw: string,
    @Query('deviceId') deviceIdRaw: string,
    @Query('targetUserId') targetUserIdRaw: string,
    @Query('targetDeviceId') targetDeviceIdRaw: string,
  ) {
    const requesterId = sanitizeQueryValue(requesterIdRaw ?? '', 'requesterId');
    const deviceId = sanitizeQueryValue(deviceIdRaw ?? '', 'deviceId');
    await this.verifyPushSecretAuth(authHeader, requesterId, deviceId);

    const targetUserId = sanitizeQueryValue(
      targetUserIdRaw ?? '',
      'targetUserId',
    );
    const targetDeviceId = sanitizeQueryValue(
      targetDeviceIdRaw ?? '',
      'targetDeviceId',
    );
    const kp = await this.keyPackageRepo.findOne({
      where: { userId: targetUserId, deviceId: targetDeviceId },
    });
    if (!kp) {
      this.logger.warn(
        `[KEY_PACKAGE_PUSH] not found target=${targetUserId}:${targetDeviceId} requester=${requesterId}:${deviceId}`,
      );
      throw new BadRequestException(
        `Key package not found for ${targetUserId}:${targetDeviceId}`,
      );
    }
    this.logger.log(
      `[KEY_PACKAGE_PUSH] found target=${targetUserId}:${targetDeviceId} requester=${requesterId}:${deviceId}`,
    );
    return { keyPackage: kp.keyPackage };
  }

  /**
   * Sends a Welcome to the target device and broadcasts the accompanying commit
   * to all current group members. Called by the background service after creating
   * the Welcome package via Rust JNI (nativeCreateWelcomeBackground).
   *
   * When `baseEpoch` is provided, the commit is validated (epoch-gated) before any Welcome or
   * broadcast, exactly like the foreground `/api/mls/commit` path: this keeps the server's
   * `activeEpoch` in phase with the real MLS epoch so subsequent foreground commits are not
   * rejected as `epoch_mismatch` (C6). A rejected commit yields neither a Welcome nor a broadcast.
   * Auth: PushSecret (no JWT).
   */
  @Post('mls/push/send-welcome-and-commit')
  async sendWelcomeAndCommitPush(
    @Headers('authorization') authHeader: string,
    @Body()
    body: {
      userId: string;
      deviceId: string;
      groupId: string;
      targetUserId: string;
      targetDeviceId: string;
      welcomePayload: string;
      ratchetTreePayload?: string;
      commitPayload: string;
      baseEpoch?: number;
    },
  ) {
    const userId = sanitizeQueryValue(body.userId ?? '', 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId ?? '', 'deviceId');
    await this.verifyPushSecretAuth(authHeader, userId, deviceId);

    const groupId = sanitizeQueryValue(body.groupId ?? '', 'groupId');
    const targetUserId = sanitizeQueryValue(
      body.targetUserId ?? '',
      'targetUserId',
    );
    const targetDeviceId = sanitizeQueryValue(
      body.targetDeviceId ?? '',
      'targetDeviceId',
    );
    if (typeof body.welcomePayload !== 'string' || !body.welcomePayload) {
      throw new BadRequestException('welcomePayload required');
    }
    if (typeof body.commitPayload !== 'string' || !body.commitPayload) {
      throw new BadRequestException('commitPayload required');
    }

    const traceId = `bg-wlc-${crypto.randomUUID().slice(0, 8)}`;
    this.logger.log(
      `[BG_WELCOME][${traceId}] START group=${groupId} sender=${userId}:${deviceId} target=${targetUserId}:${targetDeviceId} baseEpoch=${body.baseEpoch ?? 'n/a'}`,
    );

    // Le commit background avance l'epoch reel : on le valide d'abord (comme le chemin foreground)
    // pour garder activeEpoch en phase, sinon le prochain commit foreground est rejete a tort (C6).
    // On valide AVANT d'envoyer le Welcome : un rejet ne doit ni diffuser le commit ni livrer un
    // Welcome vers un etat que les autres membres n'adopteront pas. baseEpoch absent (JNI ancien) ->
    // on conserve l'ancien comportement (diffusion sans validation) pour la retrocompatibilite.
    if (typeof body.baseEpoch === 'number' && Number.isFinite(body.baseEpoch)) {
      const validation = await this.messagingService.validateCommit({
        groupId,
        deviceId,
        baseEpoch: body.baseEpoch,
      });
      if (!validation.accepted) {
        this.logger.warn(
          `[BG_WELCOME][${traceId}] REJECT commit ${validation.reason} (server epoch: ${validation.currentEpoch}, sent base: ${body.baseEpoch}) - ni Welcome ni diffusion`,
        );
        return {
          status: 'rejected',
          reason: validation.reason,
          currentEpoch: validation.currentEpoch,
        };
      }
      this.logger.log(
        `[BG_WELCOME][${traceId}] commit valide -> activeEpoch=${validation.newEpoch}`,
      );
    }

    // Send Welcome to target device (null authUserId skips membership check)
    await this.messagingService.sendWelcome(undefined, {
      targetDeviceId,
      targetUserId,
      senderUserId: userId,
      welcomePayload: body.welcomePayload,
      ratchetTreePayload: body.ratchetTreePayload,
      groupId,
    });

    // Broadcast commit to all existing group members (sender + target excluded)
    await this.messagingService.sendMessage({
      proto: body.commitPayload,
      groupId,
      senderId: userId,
      senderDeviceId: deviceId,
      isCommit: true,
      excludeDeviceIds: [`${targetUserId}:${targetDeviceId}`],
    });

    this.logger.log(`[BG_WELCOME][${traceId}] DONE`);
    return { status: 'done' };
  }

  /**
   * Sends a queued outbound MLS message (text/reply) on behalf of a device whose app is killed.
   * Called by the Android background service after encrypting the proto against the live epoch via
   * Rust JNI (nativeSendMessageBackground). `proto` is base64(raw MLS ciphertext); recipients are
   * resolved from the group membership (same fan-out + push as the gateway send path).
   * Auth: PushSecret (no JWT - app may be killed).
   */
  @Post('mls/push/send')
  async sendMessagePush(
    @Headers('authorization') authHeader: string,
    @Body()
    body: {
      userId: string;
      deviceId: string;
      groupId: string;
      proto: string;
      messageId?: string;
    },
  ) {
    const userId = sanitizeQueryValue(body.userId ?? '', 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId ?? '', 'deviceId');
    await this.verifyPushSecretAuth(authHeader, userId, deviceId);

    const groupId = sanitizeQueryValue(body.groupId ?? '', 'groupId');
    if (typeof body.proto !== 'string' || !body.proto) {
      throw new BadRequestException('proto required');
    }

    const traceId = `bg-send-${crypto.randomUUID().slice(0, 8)}`;
    this.logger.log(
      `[BG_SEND][${traceId}] START group=${groupId} sender=${userId}:${deviceId} msg=${body.messageId ?? 'none'}`,
    );

    const result = await this.messagingService.sendMessage({
      proto: body.proto,
      groupId,
      senderId: userId,
      senderDeviceId: deviceId,
    });

    this.logger.log(
      `[BG_SEND][${traceId}] DONE queued=${result.queued} sent=${result.sent}`,
    );
    return { status: 'sent', queued: result.queued, sent: result.sent };
  }

  /**
   * Diagnostic route: sends a push notification test to every device that has
   * a registered push token (online or offline).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/push/broadcast-test')
  async broadcastTestPush(
    @Body() body: { title?: string; message?: string },
    @Headers('x-user-id') requesterRaw?: string,
  ) {
    if (admin.apps.length === 0) {
      throw new BadRequestException(
        'Firebase Admin SDK is not initialized (push disabled)',
      );
    }

    const requester = sanitizeOptionalQueryValue(requesterRaw, 'x-user-id');
    const traceId = `push-test-${crypto.randomUUID().slice(0, 8)}`;
    const title = (body?.title || 'Canari - test push').trim().slice(0, 80);
    const message = (body?.message || 'Notification de diagnostic')
      .trim()
      .slice(0, 180);

    this.logger.log(
      `[PUSH_TEST][${traceId}] START requester=${requester ?? 'unknown'} title=${title}`,
    );

    const targets = await this.pushTokenRepo.find();
    let withToken = 0;
    let sent = 0;
    let failed = 0;

    for (const pushToken of targets) {
      withToken++;
      try {
        await admin.messaging().send({
          token: pushToken.token,
          notification: {
            title,
            body: message,
          },
          data: {
            type: 'push_test',
            title,
            message,
            sentAt: Date.now().toString(),
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'canari_messages',
            },
          },
          apns: {
            payload: { aps: { sound: 'default' } },
          },
        });
        sent++;
        this.logger.log(
          `[PUSH_TEST][${traceId}] SENT user=${pushToken.userId} device=${pushToken.deviceId}`,
        );
      } catch (e) {
        failed++;
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pushToken.id });
          this.logger.warn(
            `[PUSH_TEST][${traceId}] DELETED invalid token user=${pushToken.userId} device=${pushToken.deviceId}`,
          );
        }
        this.logger.warn(
          `[PUSH_TEST][${traceId}] FAILED user=${pushToken.userId} device=${pushToken.deviceId} err=${e}`,
        );
      }
    }

    this.logger.log(
      `[PUSH_TEST][${traceId}] DONE targeted=${targets.length} sent=${sent} failed=${failed}`,
    );

    return {
      status: 'done',
      traceId,
      targetedDevices: targets.length,
      withToken,
      sent,
      failed,
    };
  }
}
