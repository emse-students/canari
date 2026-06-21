import {
  Controller,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, MoreThanOrEqual } from 'typeorm';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import { PushToken } from './entities/push-token.entity';
import Redis from 'ioredis';
import {
  initializeApp,
  getApps,
  cert,
  type ServiceAccount,
} from 'firebase-admin/app';
import { RETENTION_WINDOW_MS } from './retention.constants';
import { MessagingService } from './services/messaging.service';

/**
 * Thin lifecycle controller: Firebase init, DB migration helpers, and cron jobs.
 * All route handlers have been moved to focused sub-controllers.
 */
@Controller()
export class AppController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppController.name);
  private staleDeviceInterval: ReturnType<typeof setInterval>;
  private cleanupMessagesInterval: ReturnType<typeof setInterval>;
  private cleanupStaleDevicesInterval: ReturnType<typeof setInterval>;
  private cleanupOrphanedRedisGroupsInterval: ReturnType<typeof setInterval>;
  private softDeletedGroupsCleanupInterval: ReturnType<typeof setInterval>;
  private cleanupStalePushTokensInterval: ReturnType<typeof setInterval>;
  private cleanupOrphanedMemberRowsInterval: ReturnType<typeof setInterval>;

  /**
   * Message retention / stale device TTL. A device is "stale" once its queued
   * messages have expired, meaning it can no longer catch up by processing missed
   * commits. Sourced from the shared {@link RETENTION_WINDOW_MS} so this threshold
   * stays aligned with the device-list cutoff and key-package retention.
   */
  private static readonly MESSAGE_RETENTION_MS = RETENTION_WINDOW_MS;

  constructor(
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly messagingService: MessagingService,
  ) {}

  async onModuleInit() {
    await this.ensureDeviceMetadataColumns();
    await this.ensureRevokedDevicesTable();

    // Initialize Firebase Admin SDK once if a service account is provided
    if (!getApps().length) {
      const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (sa) {
        try {
          const serviceAccount = JSON.parse(sa) as ServiceAccount;
          initializeApp({
            credential: cert(serviceAccount),
          });
          this.logger.log('[FIREBASE] Admin SDK initialized');
        } catch (e) {
          this.logger.error(
            '[FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON',
            e,
          );
        }
      } else {
        this.logger.warn(
          '[FIREBASE] FIREBASE_SERVICE_ACCOUNT_JSON not set - push disabled',
        );
      }
    }

    // Both crons run hourly - there's no point detecting staleness more
    // frequently than the message cleanup that defines it.
    const ONE_HOUR = 60 * 60 * 1000;

    // Detect stale devices: devices whose membership hasn't been updated
    // within MESSAGE_RETENTION_MS are reset to pending for re-invite.
    this.staleDeviceInterval = setInterval(() => {
      void this.detectStaleDevices().catch((e) =>
        this.logger.error('[CRON] detectStaleDevices failed', e),
      );
    }, ONE_HOUR);

    // Cleanup expired queued messages older than MESSAGE_RETENTION_MS
    this.cleanupMessagesInterval = setInterval(() => {
      void this.cleanupExpiredQueuedMessages().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredQueuedMessages failed', e),
      );
    }, ONE_HOUR);

    // GC complet des devices stale : purge l'empreinte entière (KeyPackages, prekeys,
    // push tokens, messages en file, memberships, Redis) des devices hors fenêtre de
    // rétention et sans membership active. Borne la croissance des tables per-device.
    this.cleanupStaleDevicesInterval = setInterval(() => {
      void this.cleanupStaleDevices().catch((e) =>
        this.logger.error('[CRON] cleanupStaleDevices failed', e),
      );
    }, ONE_HOUR);

    // Cleanup orphaned Redis group:members:* keys with no matching DB group
    this.cleanupOrphanedRedisGroupsInterval = setInterval(() => {
      void this.cleanupOrphanedRedisGroups().catch((e) =>
        this.logger.error('[CRON] cleanupOrphanedRedisGroups failed', e),
      );
    }, 6 * ONE_HOUR);

    // Purge soft-deleted group tombstones older than 90 days (once per day)
    this.softDeletedGroupsCleanupInterval = setInterval(() => {
      void this.cleanupSoftDeletedGroups().catch((e) =>
        this.logger.error('[CRON] cleanupSoftDeletedGroups failed', e),
      );
    }, 24 * ONE_HOUR);

    // Purge push tokens not renewed in 90 days (device désinstallé / abandonné)
    this.cleanupStalePushTokensInterval = setInterval(() => {
      void this.cleanupStalePushTokens().catch((e) =>
        this.logger.error('[CRON] cleanupStalePushTokens failed', e),
      );
    }, 24 * ONE_HOUR);

    // Purge "ghost" groups: membership rows referencing a group absent from
    // dm_groups (incomplete/legacy deletion). No other cron catches these, so
    // they would accumulate forever - this guarantees bounded growth.
    this.cleanupOrphanedMemberRowsInterval = setInterval(() => {
      void this.cleanupOrphanedMemberRows().catch((e) =>
        this.logger.error('[CRON] cleanupOrphanedMemberRows failed', e),
      );
    }, 24 * ONE_HOUR);

    this.logger.log(
      '[CRON] Stale device detection (1h), message cleanup (1h), ' +
        'stale device GC (1h), orphaned Redis groups cleanup (6h), ' +
        'soft-deleted groups purge (24h), stale push tokens purge (24h), ' +
        'orphaned member rows purge (24h) scheduled',
    );
  }

  private async ensureDeviceMetadataColumns() {
    const tableName = this.keyPackageRepo.metadata.tableName;
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceName" varchar(80)`,
    );
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceOs" varchar(32)`,
    );
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceAppVersion" varchar(32)`,
    );
  }

  private async ensureRevokedDevicesTable() {
    const tableName = this.revokedDeviceRepo.metadata.tableName;
    await this.revokedDeviceRepo.query(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" varchar(36) PRIMARY KEY,
        "userId" varchar(128) NOT NULL,
        "deviceId" varchar(128) NOT NULL,
        "revokedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_${tableName}_user_device" UNIQUE ("userId", "deviceId")
      )`,
    );
    await this.revokedDeviceRepo.query(
      `CREATE INDEX IF NOT EXISTS "IDX_${tableName}_user" ON "${tableName}" ("userId")`,
    );
  }

  onModuleDestroy() {
    clearInterval(this.staleDeviceInterval);
    clearInterval(this.cleanupMessagesInterval);
    clearInterval(this.cleanupStaleDevicesInterval);
    clearInterval(this.cleanupOrphanedRedisGroupsInterval);
    clearInterval(this.softDeletedGroupsCleanupInterval);
    clearInterval(this.cleanupStalePushTokensInterval);
    clearInterval(this.cleanupOrphanedMemberRowsInterval);
  }

  /**
   * Detect devices that have gone offline longer than the message retention
   * window and reset their membership to `pending` for a full re-invite.  Once
   * a device's queued messages have been garbage-collected it can no longer
   * catch up by processing missed commits, so the only recovery is a new Welcome.
   *
   * Liveness is measured by `KeyPackage.createdAt`, NOT `DeviceGroupMembership.updatedAt`.
   * Every WebSocket (re)connection republishes the device KeyPackage (see
   * `registerDeviceKeyPackage`), refreshing `createdAt`, whereas `updatedAt` on the
   * membership row is only bumped by `sendWelcome` / kick operations - the client no
   * longer calls `updateInvitationStatus` on normal message receipt. Keying on
   * `updatedAt` would therefore reset perfectly healthy long-lived devices in quiet
   * groups every retention window, triggering a needless kick + re-invite epoch churn
   * for the whole group.
   *
   * The `updatedAt` filter is kept only as a cheap pre-filter: a row touched within
   * the window is certainly not stale, so it can be skipped without a KeyPackage lookup.
   */
  private async detectStaleDevices() {
    const staleDate = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);

    const candidates = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .where('dgm.status = :status', { status: 'active' })
      .andWhere('dgm.updatedAt < :staleDate', { staleDate })
      .getMany();

    if (candidates.length === 0) return;

    // Keep only devices whose KeyPackage is ALSO older than the window, i.e. devices
    // that have not reconnected (republished a KeyPackage) within the retention TTL.
    const deviceIds = [...new Set(candidates.map((m) => m.deviceId))];
    const liveKeyPackages = await this.keyPackageRepo.find({
      where: { deviceId: In(deviceIds), createdAt: MoreThanOrEqual(staleDate) },
      select: ['userId', 'deviceId'],
    });
    const liveDeviceKeys = new Set(
      liveKeyPackages.map((kp) => `${kp.userId}:${kp.deviceId}`),
    );

    let reset = 0;
    for (const member of candidates) {
      if (liveDeviceKeys.has(`${member.userId}:${member.deviceId}`)) {
        // Device reconnected within the retention window - alive, leave it active.
        continue;
      }
      // Remettre en pending - le device devra recevoir un nouveau Welcome.
      member.status = 'pending';
      await this.deviceGroupRepo.save(member);
      await this.redis.srem(
        `group:members:${member.groupId}`,
        `${member.userId}:${member.deviceId}`,
      );
      reset++;
      this.logger.log(
        `[CRON] Stale device reset: device=${member.deviceId} group=${member.groupId} ` +
          `(lastUpdate=${member.updatedAt.toISOString()})`,
      );
    }

    if (reset > 0) {
      this.logger.log(
        `[CRON] detectStaleDevices: ${reset}/${candidates.length} device(s) reset to pending`,
      );
    }
  }

  /**
   * Delete queued messages older than MESSAGE_RETENTION_MS.
   */
  private async cleanupExpiredQueuedMessages() {
    const expiry = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);
    const result = await this.queuedMessageRepo.delete({
      createdAt: LessThan(expiry),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `[CRON] cleanupExpiredQueuedMessages: deleted ${result.affected} message(s)`,
      );
    }
  }

  /**
   * GC complet des devices stale : un device dont le KeyPackage statique date d'avant
   * la fenêtre de rétention ET qui n'a aucune membership active est considéré
   * définitivement hors-ligne. On purge alors TOUTE son empreinte serveur (KeyPackage,
   * prekeys one-time, push tokens, messages en file, memberships device↔groupe, sets
   * Redis) via le helper partagé {@link MessagingService.purgeDeviceFootprint}, le même
   * que la suppression manuelle d'appareil. Aligné sur la fenêtre de rétention pour
   * qu'un device encore récupérable (donc visible dans la liste) ne soit jamais purgé.
   */
  private async cleanupStaleDevices() {
    const expiry = new Date(Date.now() - RETENTION_WINDOW_MS);

    const expiredPackages = await this.keyPackageRepo.find({
      where: { createdAt: LessThan(expiry) },
    });

    if (expiredPackages.length === 0) return;

    // Conserver les devices qui ont encore une membership active.
    const deviceIds = [...new Set(expiredPackages.map((kp) => kp.deviceId))];
    const activeDevices = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .select('DISTINCT dgm.deviceId', 'deviceId')
      .where('dgm.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('dgm.status = :status', { status: 'active' })
      .getRawMany<{ deviceId: string }>();

    const activeDeviceIds = new Set(activeDevices.map((d) => d.deviceId));

    // Dédupe par (userId, deviceId) : un même device n'a qu'un KeyPackage statique,
    // mais on se protège de doublons éventuels.
    const staleDevices = new Map<
      string,
      { userId: string; deviceId: string }
    >();
    for (const kp of expiredPackages) {
      if (activeDeviceIds.has(kp.deviceId)) continue;
      staleDevices.set(`${kp.userId}:${kp.deviceId}`, {
        userId: kp.userId,
        deviceId: kp.deviceId,
      });
    }

    if (staleDevices.size === 0) return;

    for (const { userId, deviceId } of staleDevices.values()) {
      await this.messagingService.purgeDeviceFootprint(userId, deviceId);
    }

    this.logger.log(
      `[CRON] cleanupStaleDevices: purged ${staleDevices.size} stale device(s)`,
    );
  }

  /**
   * Purge soft-deleted group tombstones (deletedAt != null) older than 90 days,
   * along with their GroupMember and DeviceGroupMembership rows.
   * The tombstone is kept for 90 days so that lagging devices can still discover
   * the successor chain; after that the data has no recovery value.
   */
  private async cleanupSoftDeletedGroups() {
    const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - TOMBSTONE_MAX_AGE_MS);

    const deadGroups = await this.groupRepo.find({
      where: { deletedAt: LessThan(cutoff) },
      select: ['id'],
    });

    if (deadGroups.length === 0) return;

    const ids = deadGroups.map((g) => g.id);

    await this.groupMemberRepo.delete({ groupId: In(ids) });
    await this.deviceGroupRepo.delete({ groupId: In(ids) });
    await this.groupRepo.delete(ids);

    this.logger.log(
      `[CRON] cleanupSoftDeletedGroups: purged ${ids.length} tombstone(s)`,
    );
  }

  /**
   * Purge push tokens whose updatedAt is older than 90 days.
   * Un token non renouvelé depuis 90 jours correspond à un device désinstallé
   * ou abandonné ; continuer à l'envoyer provoque des erreurs FCM/APNs évitables.
   */
  private async cleanupStalePushTokens() {
    const PUSH_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - PUSH_TOKEN_MAX_AGE_MS);
    const result = await this.pushTokenRepo.delete({
      updatedAt: LessThan(cutoff),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `[CRON] cleanupStalePushTokens: deleted ${result.affected} token(s) not renewed in 90 days`,
      );
    }
  }

  /**
   * Cleanup orphaned Redis `group:members:*` keys that reference groups
   * no longer present in the database. Uses SCAN to avoid blocking Redis.
   */
  private async cleanupOrphanedRedisGroups() {
    const orphanedKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'group:members:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length === 0) continue;

      const groupIds = keys.map((k) => k.replace('group:members:', ''));
      const existingGroups = await this.groupRepo.find({
        where: { id: In(groupIds) },
        select: ['id'],
      });
      const existingIds = new Set(existingGroups.map((g) => g.id));

      for (let i = 0; i < keys.length; i++) {
        if (!existingIds.has(groupIds[i])) {
          orphanedKeys.push(keys[i]);
        }
      }
    } while (cursor !== '0');

    if (orphanedKeys.length > 0) {
      await this.redis.del(...orphanedKeys);
      this.logger.log(
        `[CRON] cleanupOrphanedRedisGroups: deleted ${orphanedKeys.length} key(s)`,
      );
    }
  }

  /**
   * Purge les groupes "fantômes" : des lignes de membership (dm_group_members /
   * dm_device_group_memberships) référençant un groupe absent de dm_groups.
   *
   * Le cycle normal (soft-delete → tombstone → cleanupSoftDeletedGroups) supprime
   * ces lignes avec le groupe. Mais un groupe disparu par un chemin anormal/legacy
   * (hard-delete partiel) laisse ses memberships orphelins, qu'aucun autre cron ne
   * rattrape : ils s'accumuleraient indéfiniment. On délègue la purge complète
   * (lignes DB + clés Redis history:/group:members:/pending_welcome:) au helper
   * partagé MessagingService.purgeOrphanGroups pour ne pas dupliquer la logique.
   */
  private async cleanupOrphanedMemberRows() {
    const orphanRows: { groupId: string }[] = await this.groupRepo.query(
      `SELECT DISTINCT m."groupId" FROM dm_group_members m
         LEFT JOIN dm_groups g ON g.id = m."groupId"
        WHERE g.id IS NULL
       UNION
       SELECT DISTINCT d."groupId" FROM dm_device_group_memberships d
         LEFT JOIN dm_groups g ON g.id = d."groupId"
        WHERE g.id IS NULL`,
    );

    const orphanIds = orphanRows.map((r) => r.groupId);
    if (orphanIds.length === 0) return;

    await this.messagingService.purgeOrphanGroups(orphanIds);
    this.logger.log(
      `[CRON] cleanupOrphanedMemberRows: swept ${orphanIds.length} ghost group(s)`,
    );
  }
}
