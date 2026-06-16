import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import * as admin from 'firebase-admin';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  sanitizeStringIdList,
  assertCallerOwnsUserId,
} from '../utils/sanitize';

export interface SendMessageBody {
  proto?: string;
  recipients?: { userId: string; deviceId?: string }[];
  senderId?: string;
  senderDeviceId?: string;
  groupId?: string;
  isWelcome?: boolean;
  isCommit?: boolean;
  /** userId:deviceId pairs to skip (e.g. invitee already receiving a Welcome) */
  excludeDeviceIds?: string[];
  /** When true, FCM is sent (for MLS state sync) but no notification is displayed (read receipts, own-device copies). */
  silent?: boolean;
  // legacy fields (frontend fallback / group fan-out)
  content?: string;
  type?: string;
}

export interface SendMessageResult {
  status: string;
  queued: number;
  sent: number;
}

export interface ValidateCommitBody {
  groupId: string;
  deviceId: string;
  baseEpoch: number;
}

export interface ValidateCommitResult {
  accepted: boolean;
  newEpoch?: number;
  currentEpoch?: number;
  reason?: string;
}

export interface SendWelcomeBody {
  targetDeviceId: string;
  targetUserId?: string;
  senderUserId?: string;
  welcomePayload: string;
  ratchetTreePayload?: string;
  groupId: string;
}

export interface NotifyWelcomeRequestBody {
  groupId: string;
  requesterUserId: string;
  requesterDeviceId: string;
}

/** One group cursor for batch history fetch. */
export interface HistoryBatchRequestItem {
  groupId: string;
  after?: string;
  limit?: number;
}

export interface HistoryBatchResponse {
  histories: Record<string, Record<string, unknown>[]>;
}

/** Redis stream MAXLEN (~1000) — upper bound for a full catch-up page. */
const HISTORY_FULL_PAGE_LIMIT = 1000;
/** Smaller default when `after` is set (incremental catch-up). */
const HISTORY_INCREMENTAL_DEFAULT_LIMIT = 200;
/** Max groups per batch request (guards payload size and Redis fan-out). */
const HISTORY_BATCH_MAX_GROUPS = 50;

export interface AckMessagesBody {
  userId: string;
  deviceId: string;
  messageIds: string[];
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private oneTimeKeyPackageRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  /**
   * Supprime l'intégralité de l'empreinte serveur d'un device (état per-device) :
   * memberships device↔groupe, KeyPackage statique, prekeys one-time, push tokens,
   * messages en file non délivrés, et l'appartenance Redis aux sets de routage.
   *
   * Ne touche PAS `dm_group_members` (appartenance au niveau user, partagée entre les
   * devices du même user) ni la denylist `RevokedDevice` (spécifique à la suppression
   * explicite, hors GC). Partagé entre la suppression manuelle d'appareil et le GC des
   * devices stale pour éviter toute logique de purge dupliquée.
   */
  async purgeDeviceFootprint(
    userId: string,
    deviceId: string,
  ): Promise<{
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
    queuedMessagesDeleted: number;
  }> {
    const memberships = await this.deviceGroupRepo.find({
      where: { userId, deviceId },
      select: ['groupId'],
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    await this.deviceGroupRepo.delete({ userId, deviceId });

    const memberKey = `${userId}:${deviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    const [kpResult, otkpResult, queuedResult] = await Promise.all([
      this.keyPackageRepo.delete({ userId, deviceId }),
      this.oneTimeKeyPackageRepo.delete({ userId, deviceId }),
      this.queuedMessageRepo.delete({ recipientId: userId, deviceId }),
      this.pushTokenRepo.delete({ userId, deviceId }),
    ]);

    return {
      groupsCleaned: groupIds.length,
      keyPackagesDeleted: kpResult.affected ?? 0,
      oneTimeKeyPackagesDeleted: otkpResult.affected ?? 0,
      queuedMessagesDeleted: queuedResult.affected ?? 0,
    };
  }

  private makeTraceId(scope: string): string {
    const { randomUUID } = crypto;
    return `${scope}-${randomUUID().slice(0, 8)}`;
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
   * Send a data-only FCM push to every token registered for a given queued
   * message's recipient.  Data-only means onMessageReceived() fires even when
   * the app is in the background, letting the Android service decrypt and
   * display the notification locally.
   */
  private async sendFcmForQueued(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false,
  ): Promise<void> {
    if (admin.apps.length === 0) return;

    const pushTokens = await this.pushTokenRepo.find({
      where: { userId: queued.recipientId, deviceId: queued.deviceId },
    });

    if (pushTokens.length === 0) {
      this.logger.log(
        `[PUSH_SEND][${traceId}] No push token for user=${queued.recipientId} device=${queued.deviceId}`,
      );
      return;
    }

    // Resolve group name for a meaningful fallback when the Android service
    // cannot decrypt (app killed, JNI state unavailable).
    let groupName = '';
    try {
      const group = await this.groupRepo.findOne({
        where: { id: groupId },
        select: ['name', 'isGroup'],
      });
      groupName = group?.isGroup ? (group?.name ?? '') : '';
    } catch {
      /* non-fatal */
    }

    // Resolve sender display name so the notification title is human-readable
    // when decryption fails in the background (SQLite lock / MLS state absent).
    let senderName = '';
    try {
      const rows: {
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[] = await this.groupRepo.manager.query(
        `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
        [senderId],
      );
      if (rows[0]) {
        const { displayName, firstName, lastName } = rows[0];
        senderName =
          displayName?.trim() ||
          [firstName, lastName].filter(Boolean).join(' ') ||
          '';
      }
    } catch {
      /* non-fatal */
    }

    // Inline ciphertext eliminates the extra HTTP round-trip in the Kotlin
    // service and avoids auth issues when the app is cold-started.
    // FCM data payloads are limited to 4 KB; skip inline proto for large
    // messages (media) so the service can fall back gracefully.
    const protoB64 = queued.proto ?? queued.content ?? '';
    const FCM_INLINE_LIMIT = 3_500;
    const inlineProto =
      Buffer.byteLength(protoB64, 'utf8') <= FCM_INLINE_LIMIT ? protoB64 : '';

    for (const pt of pushTokens) {
      try {
        await admin.messaging().send({
          token: pt.token,
          // Data-only → onMessageReceived() fires for foreground AND background.
          data: {
            type: 'message',
            groupId,
            queuedMessageId: queued.id,
            senderId,
            senderName,
            groupName,
            // Empty string when proto is too large; Kotlin falls back to
            // fetching it from the backend or showing a generic notification.
            proto: inlineProto,
            // Kotlin skips showNotification() when true (own-device copy, read
            // receipts, or welcome packets which are not user-visible messages).
            silent:
              silent || queued.recipientId === senderId ? 'true' : 'false',
            // Tells Kotlin to skip tryDecrypt (welcome bytes ≠ app message) and
            // go straight to MlsBackgroundWorker for pending-queue processing.
            isWelcome: queued.isWelcome ? 'true' : 'false',
            // Server queue time so the Android service can display the correct
            // message timestamp on the notification even before decryption.
            createdAt: queued.createdAt.toISOString(),
          },
          android: {
            priority: 'high',
            ttl: 86_400_000,
          },
          apns: {
            payload: { aps: { contentAvailable: true } },
            headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
          },
        });
        this.logger.log(
          `[PUSH_SEND][${traceId}] FCM sent user=${queued.recipientId} device=${pt.deviceId} inlineProto=${!!inlineProto}`,
        );
      } catch (e) {
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[PUSH_SEND][${traceId}] Deleted invalid push token user=${queued.recipientId} device=${pt.deviceId}`,
          );
        }
        this.logger.warn(
          `[PUSH_SEND][${traceId}] FCM failed user=${queued.recipientId} device=${pt.deviceId} err=${e}`,
        );
      }
    }
  }

  /**
   * Schedule a deferred FCM fallback for an "online" device.
   *
   * Android keeps the WebSocket TCP connection alive even when the app is
   * backgrounded/frozen, making `redis.exists(presence_key)` return true.
   * We send via WebSocket first, then check after DELAY_MS whether the client
   * ACKed the message.  If it has not (app could not process the WS frame),
   * we fire an FCM push so the user still gets a notification.
   */
  private scheduleDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false,
  ): void {
    const DELAY_MS = 10_000;
    // setTimeout expects () => void; extract the async work into a separate
    // method to satisfy @typescript-eslint/no-misused-promises.
    setTimeout(() => {
      void this.runDeferredPush(
        queued,
        traceId,
        groupId,
        senderId,
        silent,
      ).catch((e) =>
        this.logger.warn(
          `[PUSH_DEFERRED][${traceId}] deferred push error: ${e}`,
        ),
      );
    }, DELAY_MS);
  }

  private async runDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false,
  ): Promise<void> {
    const stillQueued = await this.queuedMessageRepo.findOne({
      where: { id: queued.id },
    });
    if (!stillQueued) {
      // Client ACKed via WebSocket - nothing to do.
      return;
    }
    this.logger.log(
      `[PUSH_DEFERRED][${traceId}] queuedId=${queued.id} still unACKed after 10 s → FCM fallback`,
    );
    await this.sendFcmForQueued(
      queued,
      `${traceId}-def`,
      groupId,
      senderId,
      silent,
    );
  }

  /**
   * Persists and delivers an MLS application message to all group members.
   * Handles both the proto path (from gateway) and legacy content path (frontend fallback).
   * For online recipients, publishes via Redis pub/sub and schedules a deferred FCM fallback.
   * For offline recipients, immediately sends an FCM push notification.
   */
  async sendMessage(body: SendMessageBody): Promise<SendMessageResult> {
    const traceId = this.makeTraceId('send');

    const ops: QueuedMessage[] = [];
    let sentCount = 0;

    this.logger.log(
      `[SEND][${traceId}] START group=${body.groupId ?? 'none'} sender=${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'} hasProto=${!!body.proto} recipients=${body.recipients?.length ?? 0} isWelcome=${!!body.isWelcome} isCommit=${!!body.isCommit}`,
    );

    if (body.proto) {
      // ── Proto path (gateway): proto = base64(raw MLS ciphertext) ─────────
      const { proto } = body;
      for (const r of body.recipients ?? []) {
        if (!r.userId || !r.deviceId) continue;
        const recipientUserId = sanitizeQueryValue(
          r.userId,
          'recipients.userId',
        );
        const recipientDeviceId = sanitizeQueryValue(
          r.deviceId,
          'recipients.deviceId',
        );
        ops.push(
          this.queuedMessageRepo.create({
            recipientId: recipientUserId,
            deviceId: recipientDeviceId,
            senderId: body.senderId,
            senderDeviceId: body.senderDeviceId,
            groupId: body.groupId,
            isWelcome: body.isWelcome,
            isCommit: body.isCommit,
            proto,
            createdAt: new Date(),
          }),
        );
      }

      // ── Fallback: recipients not provided (Redis cache miss) ─────────────
      // Resolve from DB and repopulate group:members so subsequent messages
      // no longer need this round-trip.
      if (ops.length === 0 && body.groupId) {
        const fallbackGroupId = body.groupId;
        const memberships = await this.deviceGroupRepo.find({
          where: {
            groupId: fallbackGroupId,
            status: 'active' as const,
          },
        });
        const excludeSet = new Set<string>(body.excludeDeviceIds ?? []);
        const fallback = memberships.filter(
          (m) =>
            !(
              m.userId === body.senderId && m.deviceId === body.senderDeviceId
            ) && !excludeSet.has(`${m.userId}:${m.deviceId}`),
        );
        for (const m of fallback) {
          ops.push(
            this.queuedMessageRepo.create({
              recipientId: m.userId,
              deviceId: m.deviceId,
              senderId: body.senderId,
              senderDeviceId: body.senderDeviceId,
              groupId: fallbackGroupId,
              isWelcome: body.isWelcome,
              isCommit: body.isCommit,
              proto,
              createdAt: new Date(),
            }),
          );
        }
        if (fallback.length > 0) {
          await this.redis.sadd(
            `group:members:${fallbackGroupId}`,
            ...fallback.map((m) => `${m.userId}:${m.deviceId}`),
          );
          this.logger.log(
            `[SEND][${traceId}] FALLBACK_MEMBERS_CACHE group=${fallbackGroupId} count=${fallback.length}`,
          );
        }
      }
    } else {
      // ── Legacy path (frontend fallback / group fan-out) ───────────────────
      const senderId = sanitizeQueryValue(body.senderId, 'senderId');
      const senderDeviceId = sanitizeOptionalQueryValue(
        body.senderDeviceId,
        'senderDeviceId',
      );
      const groupId = sanitizeQueryValue(body.groupId, 'groupId');
      const rawContent: unknown = body.content;
      const rawType: unknown = body.type;

      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        throw new BadRequestException('content is required');
      }

      const safeContent: string = rawContent;
      const safeType: string =
        typeof rawType === 'string' && rawType.length > 0 ? rawType : 'message';

      const targetList: { userId: string; deviceId: string }[] = [];

      if (!body.recipients || body.recipients.length === 0) {
        const members = await this.groupMemberRepo.find({ where: { groupId } });
        const memberUserIds = members
          .map((m) => m.userId)
          .filter((id) => id !== senderId);

        if (memberUserIds.length > 0) {
          const devices = await this.keyPackageRepo.find({
            where: { userId: In(memberUserIds) },
          });
          for (const d of devices) {
            targetList.push({ userId: d.userId, deviceId: d.deviceId });
          }
        }
      } else {
        for (const r of body.recipients) {
          const recipientUserId = sanitizeQueryValue(
            r.userId,
            'recipients.userId',
          );
          if (r.deviceId) {
            const recipientDeviceId = sanitizeQueryValue(
              r.deviceId,
              'recipients.deviceId',
            );
            targetList.push({
              userId: recipientUserId,
              deviceId: recipientDeviceId,
            });
          } else {
            console.warn(
              'Skipping recipient without deviceId. Fan-out is disabled for MLS security.',
            );
          }
        }
      }

      for (const r of targetList) {
        ops.push(
          this.queuedMessageRepo.create({
            recipientId: r.userId,
            deviceId: r.deviceId,
            senderId,
            senderDeviceId,
            groupId,
            content: safeContent,
            type: safeType,
            createdAt: new Date(),
          }),
        );
      }
    }

    // 1. Persist ALL messages first (survives crashes / timing races)
    if (ops.length > 0) {
      await this.queuedMessageRepo.save(ops);
      this.logger.log(`[SEND][${traceId}] QUEUED count=${ops.length}`);
    } else {
      this.logger.warn(`[SEND][${traceId}] No message queued after validation`);
    }

    // 1b. Append to history stream so late-joining devices can replay.
    // Only for regular, user-visible application messages (proto path).
    // Excluded:
    //  - Welcome / Commit: MLS epoch-transition frames that cannot be replayed out of order.
    //  - silent messages: control / state-sync payloads (read receipts, edits, deletes,
    //    reactions, and especially history_bundle replays). These are delivered reliably
    //    per-device via the QueuedMessage queue; replaying them through the capped history
    //    stream (MAXLEN ~1000) is redundant and, for history_bundle chunks of up to 200
    //    messages, would evict genuine recent messages from the stream.
    if (
      body.proto &&
      !body.isWelcome &&
      !body.isCommit &&
      !body.silent &&
      body.groupId &&
      body.senderId
    ) {
      try {
        const historyKey = `history:${body.groupId}`;
        await this.redis.xadd(
          historyKey,
          'MAXLEN',
          '~',
          '1000',
          '*',
          'sender_id',
          body.senderId,
          'content',
          body.proto,
          'timestamp',
          new Date().toISOString(),
        );
        // Refresh TTL on every write so abandoned groups are evicted after 90 days of inactivity.
        await this.redis.expire(historyKey, 90 * 24 * 60 * 60);
        this.logger.log(`[HISTORY][${traceId}] XADD group=${body.groupId}`);
      } catch (e) {
        this.logger.warn(
          `[HISTORY][${traceId}] XADD failed group=${body.groupId}: ${e}`,
        );
      }
    }

    // 2. Best-effort real-time delivery for online recipients
    for (const queued of ops) {
      const redisKey = `user:online:${queued.recipientId}:${queued.deviceId}`;
      const isOnline = await this.redis.exists(redisKey);
      this.logger.log(
        `[SEND][${traceId}] recipient=${queued.recipientId}:${queued.deviceId} online=${!!isOnline} queuedId=${queued.id}`,
      );
      if (isOnline) {
        const envelope = JSON.stringify({
          recipientId: queued.recipientId,
          deviceId: queued.deviceId,
          senderId: body.senderId ?? '',
          senderDeviceId: body.senderDeviceId ?? '',
          groupId: body.groupId ?? '',
          isWelcome: body.isWelcome ?? false,
          isCommit: body.isCommit ?? false,
          proto: queued.proto ?? queued.content ?? '',
          queuedMessageId: queued.id,
          createdAt: queued.createdAt.toISOString(),
        });
        await this.redis.publish('chat:messages', envelope);
        sentCount++;
        this.logger.log(
          `[SEND][${traceId}] PUBLISHED recipient=${queued.recipientId}:${queued.deviceId} queuedId=${queued.id}`,
        );

        // Deferred FCM fallback: Android keeps the WebSocket TCP connection alive
        // even when the app is in the background, so `isOnline` can be true while
        // the app can no longer process WebSocket frames. If the queued message is
        // still unACKed after DEFERRED_PUSH_DELAY_MS, the WebSocket delivery failed
        // silently → fall back to FCM so the user still gets a notification.
        // Welcome packages use a silent push (no visible notification) so the
        // app can process the MLS welcome without spamming the user.
        if (!body.isCommit) {
          this.scheduleDeferredPush(
            queued,
            traceId,
            body.groupId ?? '',
            body.senderId ?? '',
            body.isWelcome ? true : (body.silent ?? false),
          );
        } else {
          this.scheduleDeferredPush(
            queued,
            traceId,
            body.groupId ?? '',
            body.senderId ?? '',
            true,
          );
        }
      } else {
        // Offline recipient: FCM push (silent for commits/welcomes).
        await this.sendFcmForQueued(
          queued,
          traceId,
          body.groupId ?? '',
          body.senderId ?? '',
          body.isCommit || body.isWelcome ? true : (body.silent ?? false),
        );
      }
    }

    this.logger.log(
      `[SEND][${traceId}] DONE queued=${ops.length} realtime=${sentCount}`,
    );

    return { status: 'processed', queued: ops.length, sent: sentCount };
  }

  /**
   * Epoch-gated commit: validates that the sender's baseEpoch matches the
   * group's activeEpoch before allowing the commit through.
   * Prevents MLS epoch forks caused by concurrent commits from multiple devices.
   *
   * Returns accepted=true with newEpoch on success, or accepted=false with
   * currentEpoch and a reason string when the commit is rejected.
   */
  async validateCommit(
    body: ValidateCommitBody,
  ): Promise<ValidateCommitResult> {
    const traceId = this.makeTraceId('commit');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const baseEpoch =
      typeof body.baseEpoch === 'number' && Number.isFinite(body.baseEpoch)
        ? Math.floor(body.baseEpoch)
        : -1;

    if (baseEpoch < 0) {
      this.logger.warn(
        `[COMMIT][${traceId}] Invalid baseEpoch=${body.baseEpoch} group=${groupId} device=${deviceId}`,
      );
      throw new BadRequestException('baseEpoch must be a non-negative integer');
    }

    this.logger.log(
      `[COMMIT][${traceId}] START group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`,
    );

    // Serialize via Redis lock to prevent TOCTOU races.
    // Two devices sending commits at the same epoch would both read the same
    // activeEpoch - the lock ensures only one gets through.
    const lockKey = `mls:commitlock:${groupId}`;
    const lockAcquired = await this.redis.set(lockKey, deviceId, 'EX', 5, 'NX');
    if (lockAcquired !== 'OK') {
      // Another commit is being validated right now - reject to retry.
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT concurrent_commit group=${groupId} currentEpoch=${group?.activeEpoch ?? 0}`,
      );
      return {
        accepted: false,
        currentEpoch: group?.activeEpoch ?? 0,
        reason: 'concurrent_commit',
      };
    }

    try {
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      if (!group) {
        this.logger.error(`[COMMIT][${traceId}] Group not found: ${groupId}`);
        throw new BadRequestException(`Group ${groupId} not found`);
      }

      // When activeEpoch is 0 the server has no prior tracking for this group.
      // Treat this as "uninitialized" and fast-forward to baseEpoch + 1 so
      // that client and server epoch state converge on the first accepted commit.
      if (baseEpoch !== group.activeEpoch && group.activeEpoch !== 0) {
        this.logger.warn(
          `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} activeEpoch=${group.activeEpoch}`,
        );
        return {
          accepted: false,
          currentEpoch: group.activeEpoch,
          reason: 'epoch_mismatch',
        };
      }

      // Advance the epoch (from wherever the server currently is)
      group.activeEpoch = baseEpoch + 1;
      await this.groupRepo.save(group);

      this.logger.log(
        `[COMMIT][${traceId}] ACCEPT group=${groupId} newEpoch=${group.activeEpoch}`,
      );

      return { accepted: true, newEpoch: group.activeEpoch };
    } finally {
      // Libération atomique via Lua : évite la race GET→DEL
      const released = await this.redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
        1,
        lockKey,
        deviceId,
      );
      if (released === 1) {
        this.logger.log(
          `[COMMIT][${traceId}] Lock released for group=${groupId}`,
        );
      } else {
        this.logger.warn(
          `[COMMIT][${traceId}] Lock already expired or stolen for group=${groupId}`,
        );
      }
    }
  }

  /**
   * Delivers an MLS Welcome message and optional ratchet tree to a target device.
   * Verifies the sender is a member of the group, queues the welcome, performs
   * real-time delivery if the target is online, and updates DeviceGroupMembership status.
   */
  async sendWelcome(
    authUserIdRaw: string | undefined,
    body: SendWelcomeBody,
  ): Promise<{ status: string }> {
    const traceId = this.makeTraceId('welcome-send');
    const targetDeviceId = sanitizeQueryValue(
      body.targetDeviceId,
      'targetDeviceId',
    );
    const targetUserId = sanitizeOptionalQueryValue(
      body.targetUserId,
      'targetUserId',
    );
    const senderUserId =
      sanitizeOptionalQueryValue(body.senderUserId, 'senderUserId') || 'system';
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    // Vérifier que l'expéditeur authentifié est membre du groupe.
    // authUserIdRaw provient du header x-user-id positionné par le proxy après validation JWT.
    const authUserId = sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id');
    if (authUserId) {
      const membership = await this.groupMemberRepo.findOne({
        where: { groupId: safeGroupId, userId: authUserId },
      });
      if (!membership) {
        this.logger.warn(
          `[WELCOME][${traceId}] AUTHZ FAIL sender=${authUserId} not member of group=${safeGroupId}`,
        );
        throw new ForbiddenException(
          `User ${authUserId} is not a member of group ${safeGroupId}`,
        );
      }
    }

    this.logger.log(
      `[WELCOME][${traceId}] START group=${safeGroupId} sender=${senderUserId} target=${targetUserId ?? 'unknown'}:${targetDeviceId} payloadLen=${body.welcomePayload?.length ?? 0} ratchetTreeLen=${body.ratchetTreePayload?.length ?? 0}`,
    );

    // Look up recipient device - include userId in the query when provided so the lookup
    // is unambiguous even if two users happen to share the same raw device ID string
    // (common in same-browser multi-tab testing).
    const query: Record<string, string> = { deviceId: targetDeviceId };
    if (targetUserId) {
      query.userId = targetUserId;
    }
    const deviceInfo = await this.keyPackageRepo.findOne({ where: query });

    if (!deviceInfo) {
      this.logger.error(
        `[WELCOME][${traceId}] Target device not found target=${targetUserId ?? 'unknown'}:${targetDeviceId}`,
      );
      throw new Error(
        `Device ${targetDeviceId} (user: ${targetUserId ?? 'unknown'}) not found. Cannot deliver Welcome message.`,
      );
    }

    const queuedWelcome = this.queuedMessageRepo.create({
      recipientId: deviceInfo.userId,
      deviceId: targetDeviceId,
      senderId: senderUserId,
      groupId: safeGroupId,
      proto: body.welcomePayload,
      isWelcome: true,
      ratchetTree: body.ratchetTreePayload,
      createdAt: new Date(),
    });
    await this.queuedMessageRepo.save(queuedWelcome);
    this.logger.log(
      `[WELCOME][${traceId}] QUEUED id=${queuedWelcome.id} recipient=${deviceInfo.userId}:${targetDeviceId} group=${safeGroupId}`,
    );

    // Real-time push via Gateway when the target device is currently online.
    const redisKey = `user:online:${deviceInfo.userId}:${targetDeviceId}`;
    const isOnline = await this.redis.exists(redisKey);
    this.logger.log(
      `[WELCOME][${traceId}] PRESENCE key=${redisKey} online=${!!isOnline}`,
    );
    if (isOnline) {
      const ciphertext = Buffer.from(body.welcomePayload, 'base64');
      const envelope = JSON.stringify({
        recipientId: deviceInfo.userId,
        deviceId: targetDeviceId,
        senderId: senderUserId,
        senderDeviceId: '',
        groupId: safeGroupId,
        isWelcome: true,
        ratchetTree: body.ratchetTreePayload,
        proto: ciphertext.toString('base64'),
        // Sans cet id, un Welcome traité en realtime ne peut pas être ACKé côté client :
        // la ligne durable survit et le prochain pull (ex. restart) le redélivre, ce qui
        // provoque un retraitement NoMatchingKeyPackage destructeur. Le propager permet
        // l'ACK immédiat → suppression de la queue → pas de redélivraison.
        queuedMessageId: queuedWelcome.id,
      });
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISH key=${redisKey} envelopeLen=${envelope.length}`,
      );
      await this.redis.publish('chat:messages', envelope);
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISHED key=${redisKey} queuedId=${queuedWelcome.id}`,
      );
    } else {
      // Device offline (app killed): the realtime WS path can't reach it, so push
      // the Welcome over FCM. Without this the recipient is never woken for the
      // Welcome and stays unjoined - the subsequent message push then fails to
      // decrypt ("Groupe introuvable") and shows a generic "Nouveau message de X".
      // Routed by data.isWelcome=true to the Android background welcome receiver,
      // which joins the group; the queue row is reconciled idempotently on next
      // foreground pull (group already in WASM → ACK, no re-processing).
      this.logger.log(
        `[WELCOME][${traceId}] OFFLINE_PUSH key=${redisKey} queuedId=${queuedWelcome.id}`,
      );
      await this.sendFcmForQueued(
        queuedWelcome,
        traceId,
        safeGroupId,
        senderUserId,
        true,
      );
    }

    // Upsert DeviceGroupMembership to active.
    // INSERT ... ON CONFLICT DO UPDATE garantit la création du record même si aucune
    // invitation préalable n'existait (cas reboot : groupe tout neuf, aucun record pending).
    // Un plain UPDATE WHERE status='pending' touchait 0 lignes dans ce cas, laissant
    // le device sans record → processPendingInvitations le kickait par erreur.
    await this.deviceGroupRepo.upsert(
      {
        deviceId: targetDeviceId,
        groupId: safeGroupId,
        userId: deviceInfo.userId,
        status: 'pending' as const,
      },
      {
        conflictPaths: ['deviceId', 'groupId'],
        skipUpdateIfNoValuesChanged: true,
      },
    );

    // Device can now decrypt - add it to the routing set.
    await this.redis.sadd(
      `group:members:${safeGroupId}`,
      `${deviceInfo.userId}:${targetDeviceId}`,
    );

    this.logger.log(
      `[WELCOME][${traceId}] DONE group=${safeGroupId} target=${deviceInfo.userId}:${targetDeviceId}`,
    );

    return { status: 'queued' };
  }

  /**
   * Broadcasts a welcome_request signal to one online group member to trigger
   * a re-invite for the requesting device.  Falls back to the DB to repopulate
   * the Redis routing cache when the set is empty after a service restart.
   */
  async notifyWelcomeRequest(
    body: NotifyWelcomeRequestBody,
    _depth = 0,
  ): Promise<{ status: string; target?: string }> {
    const traceId = this.makeTraceId('welcome-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(
      body.requesterUserId,
      'requesterUserId',
    );
    const requesterDeviceId = sanitizeQueryValue(
      body.requesterDeviceId,
      'requesterDeviceId',
    );

    // Si ce groupe a un successeur, rediriger vers le groupe terminal (évite les dead-ends
    // où les membres actifs ont migré vers le successeur et ne répondent plus à l'ancien).
    if (_depth < 10) {
      const groupMeta = await this.groupRepo.findOne({
        where: { id: groupId },
      });
      if (groupMeta?.successorId) {
        this.logger.log(
          `[WELCOME_REQ][${traceId}] group=${groupId} has successor=${groupMeta.successorId} - redirecting`,
        );
        return this.notifyWelcomeRequest(
          { ...body, groupId: groupMeta.successorId },
          _depth + 1,
        );
      }
    }

    // Atomically pick one online group member that is not the requester.
    // Using a single server-side selection avoids the multi-connection race that
    // occurs when the gateway forwards the WS frame: each concurrent connection
    // from the requester's device would call forward_to_one_peer independently,
    // and since SMEMBERS returns an unordered set each call can pick a different
    // peer, causing multiple devices to concurrently commit an add for the same
    // invitation.
    let members: string[] = await this.redis.smembers(
      `group:members:${groupId}`,
    );
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    // Redis routing set is a cache: it can be empty after a service restart or
    // Redis flush even though active devices exist in the DB.
    // Fall back to the DB and repopulate the cache so routing is restored.
    if (members.length === 0) {
      this.logger.log(
        `[WELCOME_REQ][${traceId}] REDIS_EMPTY - falling back to DB for group=${groupId}`,
      );
      const dbMembers = await this.deviceGroupRepo.find({
        where: { groupId, status: 'active' as const },
      });
      if (dbMembers.length > 0) {
        members = dbMembers.map((m) => `${m.userId}:${m.deviceId}`);
        await this.redis.sadd(`group:members:${groupId}`, ...members);
        this.logger.log(
          `[WELCOME_REQ][${traceId}] DB_FALLBACK found=${dbMembers.length} repopulated Redis cache`,
        );
      }
    }

    this.logger.log(
      `[WELCOME_REQ][${traceId}] START group=${groupId} requester=${senderKey} members=${members.length}`,
    );

    const notification = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) {
        this.logger.warn(
          `[WELCOME_REQ][${traceId}] Malformed group member entry='${member}' group=${groupId}`,
        );
        continue;
      }
      const onlineKey = `user:online:${memberUserId}:${memberDeviceId}`;
      const isOnline = await this.redis.exists(onlineKey);
      this.logger.log(
        `[WELCOME_REQ][${traceId}] Candidate=${member} online=${!!isOnline}`,
      );
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // Re-use the proto field as a JSON-encoded control payload so the
            // gateway can relay it as a plain text WS frame without extra decoding.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          }),
        );
        this.logger.log(
          `[WELCOME_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`,
        );

        // Drain any welcome_requests that were stored while no peer was online,
        // so this newly-online peer handles all pending invitees in one pass.
        const pendingSetKey = `pending_welcome:${groupId}`;
        const stored: string[] = await this.redis.smembers(pendingSetKey);
        let drained = 0;
        for (const storedKey of stored) {
          if (storedKey === senderKey) continue; // already forwarded above
          const [storedUserId, storedDeviceId] = storedKey.split(':');
          if (!storedUserId || !storedDeviceId) continue;
          await this.redis.publish(
            'chat:messages',
            JSON.stringify({
              recipientId: memberUserId,
              deviceId: memberDeviceId,
              proto: Buffer.from(
                JSON.stringify({
                  type: 'welcome_request',
                  groupId,
                  requesterUserId: storedUserId,
                  requesterDeviceId: storedDeviceId,
                }),
              ).toString('base64'),
              isWelcomeRequest: true,
              groupId,
              senderId: storedUserId,
              senderDeviceId: storedDeviceId,
            }),
          );
          drained++;
        }
        if (stored.length > 0) {
          await this.redis.del(pendingSetKey);
          this.logger.log(
            `[WELCOME_REQ][${traceId}] Drained ${drained} stored welcome_request(s) for group=${groupId}`,
          );
        }

        return { status: 'forwarded', target: member };
      }
    }

    // No peer online - persist so the request is replayed when a peer connects.
    const pendingSetKey = `pending_welcome:${groupId}`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(pendingSetKey, senderKey);
    pipeline.expire(pendingSetKey, 86400); // 24 h TTL
    await pipeline.exec();

    // Stocker également par membre dans pending_welcome_notify:{userId} pour que le
    // Gateway puisse drainer les signaux dès qu'un membre se reconnecte, sans attendre
    // une prochaine welcome_request. Le format est le JSON que le Gateway enverra
    // directement au client WebSocket.
    const notificationFrame = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });
    const uniqueMemberUserIds = [
      ...new Set(
        members
          .filter((m) => m !== senderKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean),
      ),
    ];
    if (uniqueMemberUserIds.length > 0) {
      const notifyPipeline = this.redis.pipeline();
      for (const memberUserId of uniqueMemberUserIds) {
        const notifyKey = `pending_welcome_notify:${memberUserId}`;
        notifyPipeline.rpush(notifyKey, notificationFrame);
        notifyPipeline.expire(notifyKey, 86400); // même TTL 24 h
      }
      await notifyPipeline.exec();
    }

    // Wake up offline peers via FCM so they reconnect and drain the pending request
    // without waiting for an organic reconnection.
    await this.sendFcmWelcomeRequestPending(
      groupId,
      members,
      senderKey,
      traceId,
    );

    this.logger.log(
      `[WELCOME_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} - stored in Redis, FCM sent to peers`,
    );
    return { status: 'no_peer_online' };
  }

  /**
   * Clears the pending welcome_request queue for a group.
   * Called by the reboot winner after claiming the successor so that stale
   * welcome_requests stored while peers were offline are not re-delivered.
   */
  async clearPendingWelcomeRequests(
    groupId: string,
  ): Promise<{ cleared: boolean }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const pendingSetKey = `pending_welcome:${safeGroupId}`;
    const deleted = await this.redis.del(pendingSetKey);
    this.logger.log(
      `[WELCOME_REQ] clearPendingWelcomeRequests group=${safeGroupId} deleted=${deleted}`,
    );
    return { cleared: deleted > 0 };
  }

  /**
   * Identifie parmi `groupIds` ceux qui n'ont plus aucune ligne dans `dm_groups`
   * (ni active, ni tombstone soft-delete) et purge l'intégralité de leur résidu
   * serveur : messages en file, lignes de membership et d'appartenance device,
   * plus les clés Redis `history:`, `group:members:` et `pending_welcome:`.
   *
   * Ces groupes proviennent d'une suppression incomplète : leur ligne a disparu
   * mais leurs données survivantes provoquent côté client une boucle de recovery
   * (welcome_request/reboot sans cible) et un historique fantôme indéchiffrable.
   * Un groupe soft-deleted garde sa ligne (tombstone) et n'est donc jamais purgé :
   * sa chaîne de successeurs reste pilotée par le client.
   *
   * @returns l'ensemble des `groupId` encore présents dans `dm_groups` (livrables).
   */
  async purgeOrphanGroups(groupIds: string[]): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();

    const existing = await this.groupRepo.find({
      where: { id: In(groupIds) },
      select: ['id'],
    });
    const existingIds = new Set(existing.map((g) => g.id));
    const orphaned = groupIds.filter((id) => !existingIds.has(id));
    if (orphaned.length === 0) return existingIds;

    await Promise.all([
      this.queuedMessageRepo.delete({ groupId: In(orphaned) }),
      this.groupMemberRepo.delete({ groupId: In(orphaned) }),
      this.deviceGroupRepo.delete({ groupId: In(orphaned) }),
      ...orphaned.flatMap((id) => [
        this.redis.del(`history:${id}`),
        this.redis.del(`group:members:${id}`),
        this.redis.del(`pending_welcome:${id}`),
      ]),
    ]);
    this.logger.warn(
      `[ORPHAN_PURGE] purged ${orphaned.length} group(s) absent from dm_groups: ${orphaned.join(', ')}`,
    );
    return existingIds;
  }

  /**
   * Clamps history page size: full catch-up may read up to the stream MAXLEN;
   * incremental (`after` set) defaults to a smaller page.
   */
  private resolveHistoryLimit(
    after: string | undefined,
    limitRaw?: number,
  ): number {
    if (limitRaw !== undefined && Number.isFinite(limitRaw)) {
      return Math.min(
        Math.max(Math.trunc(limitRaw), 1),
        HISTORY_FULL_PAGE_LIMIT,
      );
    }
    return after ? HISTORY_INCREMENTAL_DEFAULT_LIMIT : HISTORY_FULL_PAGE_LIMIT;
  }

  /** Maps Redis stream entries to the JSON shape expected by clients. */
  private mapHistoryEntries(
    entries: [string, string[]][],
  ): Record<string, unknown>[] {
    return entries.map(([id, fields]) => {
      const msg: Record<string, unknown> = { id };
      for (let i = 0; i < fields.length; i += 2) {
        msg[fields[i]] = fields[i + 1];
      }
      return msg;
    });
  }

  /**
   * Reads one page from `history:{groupId}` (no auth — caller must gate access).
   * `after` is an exclusive Redis stream ID (`(${after}` in XRANGE).
   */
  private async readHistoryStreamPage(
    groupId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const streamKey = `history:${groupId}`;
    const startId = after ? `(${after}` : '-';
    const entries = await this.redis.xrange(
      streamKey,
      startId,
      '+',
      'COUNT',
      limit,
    );
    this.logger.log(
      `[HISTORY] group=${groupId} after=${after ?? 'start'} limit=${limit} entries=${entries.length}`,
    );
    return this.mapHistoryEntries(entries);
  }

  /**
   * Returns group IDs the caller may read. Orphans are purged once per batch;
   * non-members are omitted (batch) or rejected (single-group).
   */
  private async authorizeHistoryGroups(
    groupIds: string[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    rejectForbidden: boolean,
  ): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();

    const existingIds = await this.purgeOrphanGroups(groupIds);
    const deliverable = groupIds.filter((id) => existingIds.has(id));

    if (headerGlobalAdmin === 'true') {
      return new Set(deliverable);
    }

    const authUserId = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!authUserId) {
      throw new ForbiddenException(
        'History requires authenticated user context',
      );
    }

    if (deliverable.length === 0) {
      if (rejectForbidden && groupIds.length === 1) {
        return new Set();
      }
      return new Set();
    }

    const memberships = await this.groupMemberRepo.find({
      where: { userId: authUserId, groupId: In(deliverable) },
      select: ['groupId'],
    });
    const memberIds = new Set(memberships.map((m) => m.groupId));

    if (rejectForbidden && groupIds.length === 1) {
      const gid = groupIds[0];
      if (!existingIds.has(gid)) {
        return new Set();
      }
      if (!memberIds.has(gid)) {
        throw new ForbiddenException('Not a member of this group');
      }
    }

    return memberIds;
  }

  /**
   * Returns the Redis stream history for a group, with optional cursor-based
   * pagination via an afterStreamId parameter.
   * Enforces group membership for non-admin callers.
   */
  async getHistory(
    groupIdRaw: string,
    after: string | undefined,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limitRaw?: number,
  ): Promise<Record<string, unknown>[]> {
    const groupId = sanitizeQueryValue(groupIdRaw, 'groupId');
    const limit = this.resolveHistoryLimit(after, limitRaw);

    const authorized = await this.authorizeHistoryGroups(
      [groupId],
      headerUserId,
      headerGlobalAdmin,
      true,
    );
    if (!authorized.has(groupId)) {
      this.logger.warn(`[HISTORY] group=${groupId} orphaned - purged, empty`);
      return [];
    }

    try {
      return await this.readHistoryStreamPage(groupId, after, limit);
    } catch (e) {
      this.logger.error(`[HISTORY] group=${groupId} error=${e}`);
      throw new ServiceUnavailableException('History stream unavailable');
    }
  }

  /**
   * Fetches the first page of history for multiple groups in one round-trip.
   * Unauthorized or orphaned groups return an empty array (no error).
   */
  async getHistoryBatch(
    items: HistoryBatchRequestItem[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
  ): Promise<HistoryBatchResponse> {
    if (!Array.isArray(items)) {
      throw new BadRequestException('groups must be an array');
    }
    if (items.length > HISTORY_BATCH_MAX_GROUPS) {
      throw new BadRequestException(
        `At most ${HISTORY_BATCH_MAX_GROUPS} groups per batch`,
      );
    }

    const normalized = items.map((item) => ({
      groupId: sanitizeQueryValue(item.groupId, 'groupId'),
      after: item.after?.trim() || undefined,
      limit: this.resolveHistoryLimit(item.after, item.limit),
    }));

    const groupIds = [...new Set(normalized.map((i) => i.groupId))];
    const authorized = await this.authorizeHistoryGroups(
      groupIds,
      headerUserId,
      headerGlobalAdmin,
      false,
    );

    const histories: Record<string, Record<string, unknown>[]> = {};
    await Promise.all(
      normalized.map(async ({ groupId, after, limit }) => {
        if (!authorized.has(groupId)) {
          histories[groupId] = [];
          return;
        }
        try {
          histories[groupId] = await this.readHistoryStreamPage(
            groupId,
            after,
            limit,
          );
        } catch (e) {
          this.logger.error(`[HISTORY_BATCH] group=${groupId} error=${e}`);
          histories[groupId] = [];
        }
      }),
    );

    this.logger.log(
      `[HISTORY_BATCH] groups=${normalized.length} authorized=${authorized.size}`,
    );
    return { histories };
  }

  /**
   * Fetches all queued (undelivered) messages for a specific device from the DB queue,
   * ordered by creation time ascending.  Enforces that the caller owns the userId.
   */
  async fetchMessages(
    userId: string,
    deviceId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limit = 500,
    after?: string,
  ): Promise<QueuedMessage[]> {
    const traceId = this.makeTraceId('fetch-msg');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot fetch messages for another user',
    );

    const safeLimit = Math.min(Math.max(limit, 1), 1000);

    this.logger.log(
      `[MSG_FETCH][${traceId}] START user=${safeUserId} device=${safeDeviceId} limit=${safeLimit} after=${after ?? 'none'}`,
    );

    const qb = this.queuedMessageRepo
      .createQueryBuilder('q')
      .where('q.recipientId = :userId', { userId: safeUserId })
      .andWhere('q.deviceId = :deviceId', { deviceId: safeDeviceId })
      .orderBy('q.createdAt', 'ASC')
      .take(safeLimit);

    if (after?.trim()) {
      qb.andWhere('q.createdAt > :after', { after: new Date(after) });
    }

    const messages = await qb.getMany();

    // Écarte les messages adressés à un groupe disparu de dm_groups : orphelins
    // jamais déchiffrables ni ACK par le client, ils provoqueraient sinon une
    // boucle de recovery infinie. purgeOrphanGroups en purge aussi le résidu
    // serveur (file, memberships, clés Redis) - voir sa doc.
    const groupIds = [
      ...new Set(
        messages.map((m) => m.groupId).filter((id): id is string => !!id),
      ),
    ];
    const existingIds = await this.purgeOrphanGroups(groupIds);
    const deliverable = messages.filter(
      (m) => !m.groupId || existingIds.has(m.groupId),
    );
    if (deliverable.length !== messages.length) {
      this.logger.warn(
        `[MSG_FETCH][${traceId}] dropped ${messages.length - deliverable.length} orphaned message(s)`,
      );
    }

    this.logger.log(
      `[MSG_FETCH][${traceId}] DONE user=${safeUserId} device=${safeDeviceId} count=${deliverable.length}`,
    );
    return deliverable;
  }

  /**
   * Acknowledges (deletes) processed messages from the delivery queue by ID.
   * Enforces that the caller owns the userId and only deletes messages addressed
   * to the specified device.
   */
  async acknowledgeMessages(
    body: AckMessagesBody,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
  ): Promise<{ status: string; count: number }> {
    const traceId = this.makeTraceId('ack');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeMessageIds = sanitizeStringIdList(body.messageIds);
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot acknowledge messages for another user',
    );

    this.logger.log(
      `[ACK][${traceId}] START user=${safeUserId} device=${safeDeviceId} requested=${safeMessageIds.length}`,
    );

    if (safeMessageIds.length === 0) {
      this.logger.warn(
        `[ACK][${traceId}] IGNORE empty messageIds user=${safeUserId} device=${safeDeviceId}`,
      );
      return { status: 'ignored', count: 0 };
    }

    // On supprime uniquement les messages que le client a confirmés
    const result = await this.queuedMessageRepo.delete({
      id: In(safeMessageIds),
      recipientId: safeUserId,
      deviceId: safeDeviceId, // Sécurité pour éviter qu'un device supprime les messages d'un autre
    });

    this.logger.log(
      `[ACK][${traceId}] DONE deleted=${result.affected || 0} user=${safeUserId} device=${safeDeviceId}`,
    );

    return { status: 'deleted', count: result.affected || 0 };
  }

  /**
   * Sends a silent FCM data push to every registered device of each group member
   * (except the requester) to wake them up when a welcome_request is pending and
   * no peer was online to handle it.
   *
   * On reception, the Kotlin service reconnects the WebSocket; the normal
   * welcome-drain flow then forwards the pending welcome_request automatically.
   */
  private async sendFcmWelcomeRequestPending(
    groupId: string,
    members: string[],
    requesterKey: string,
    traceId: string,
  ): Promise<void> {
    if (admin.apps.length === 0) return;

    const [requesterUserId, requesterDeviceId] = requesterKey.split(':');

    const uniqueUserIds = [
      ...new Set(
        members
          .filter((m) => m !== requesterKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean),
      ),
    ];

    // Batch-load all tokens in a single query instead of one per user.
    if (uniqueUserIds.length === 0) return;
    const allTokens = await this.pushTokenRepo.find({
      where: { userId: In(uniqueUserIds) },
    });

    await Promise.all(
      allTokens.map(async (pt) => {
        try {
          await admin.messaging().send({
            token: pt.token,
            data: {
              type: 'welcome_request_pending',
              groupId,
              requesterUserId: requesterUserId ?? '',
              requesterDeviceId: requesterDeviceId ?? '',
            },
            android: { priority: 'high', ttl: 3_600_000 }, // 1 h < 24 h Redis TTL
            apns: {
              payload: { aps: { contentAvailable: true } },
              headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
            },
          });
          this.logger.log(
            `[WELCOME_REQ][${traceId}] FCM welcome_request_pending user=${pt.userId} device=${pt.deviceId}`,
          );
        } catch (e) {
          if (this.isTerminalPushTokenError(e)) {
            await this.pushTokenRepo.delete({ id: pt.id });
            this.logger.warn(
              `[WELCOME_REQ][${traceId}] Deleted invalid push token user=${pt.userId} device=${pt.deviceId}`,
            );
          }
          this.logger.warn(
            `[WELCOME_REQ][${traceId}] FCM failed user=${pt.userId} device=${pt.deviceId} err=${e}`,
          );
        }
      }),
    );
  }

  /**
   * Sends an FCM notification to all registered devices of a given user.
   * Used for side-channel social signals (reactions, mentions) where the
   * server never sees the MLS plaintext.
   *
   * Returns { sent, failed } - failure is non-fatal for the caller.
   */
  async sendPushToUser(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<{ sent: number; failed: number }> {
    if (admin.apps.length === 0) return { sent: 0, failed: 0 };

    const traceId = this.makeTraceId('social-push');
    const pushTokens = await this.pushTokenRepo.find({ where: { userId } });

    if (pushTokens.length === 0) {
      this.logger.log(`[SOCIAL_PUSH][${traceId}] No token for user=${userId}`);
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const pt of pushTokens) {
      try {
        // Data-only → onMessageReceived() fires même en arrière-plan.
        // Le code Kotlin lit data["type"] pour choisir le canal et construire le deepLink.
        await admin.messaging().send({
          token: pt.token,
          data: { ...data, title, body },
          android: { priority: 'high' },
        });
        sent++;
        this.logger.log(
          `[SOCIAL_PUSH][${traceId}] sent user=${userId} device=${pt.deviceId}`,
        );
      } catch (e) {
        failed++;
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[SOCIAL_PUSH][${traceId}] deleted invalid token user=${userId} device=${pt.deviceId}`,
          );
        }
        this.logger.warn(
          `[SOCIAL_PUSH][${traceId}] FCM failed user=${userId} device=${pt.deviceId} err=${e}`,
        );
      }
    }
    return { sent, failed };
  }
}
