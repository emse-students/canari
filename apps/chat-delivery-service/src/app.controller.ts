import {
  Controller,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import Redis from 'ioredis';
import * as admin from 'firebase-admin';

/**
 * Thin lifecycle controller: Firebase init, DB migration helpers, and cron jobs.
 * All route handlers have been moved to focused sub-controllers.
 */
@Controller()
export class AppController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppController.name);
  private staleDeviceInterval: ReturnType<typeof setInterval>;
  private cleanupMessagesInterval: ReturnType<typeof setInterval>;
  private cleanupKeyPackagesInterval: ReturnType<typeof setInterval>;
  private cleanupOrphanedRedisGroupsInterval: ReturnType<typeof setInterval>;
  private softDeletedGroupsCleanupInterval: ReturnType<typeof setInterval>;

  /**
   * Single source of truth for message retention / stale device TTL.
   * A device is "stale" when its queued messages have expired (7 days),
   * meaning it can no longer catch up by processing missed commits.
   */
  private static readonly MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    await this.ensureDeviceMetadataColumns();
    await this.ensureRevokedDevicesTable();

    // Initialize Firebase Admin SDK once if a service account is provided
    if (!admin.apps.length) {
      const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (sa) {
        try {
          const serviceAccount = JSON.parse(sa) as admin.ServiceAccount;
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
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

    // Cleanup KeyPackages older than 30 days whose device has no active membership
    this.cleanupKeyPackagesInterval = setInterval(() => {
      void this.cleanupExpiredKeyPackages().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredKeyPackages failed', e),
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

    this.logger.log(
      '[CRON] Stale device detection (1h), message cleanup (1h), ' +
        'key-package cleanup (1h), orphaned Redis groups cleanup (6h), ' +
        'soft-deleted groups purge (24h) scheduled',
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
    clearInterval(this.cleanupKeyPackagesInterval);
    clearInterval(this.cleanupOrphanedRedisGroupsInterval);
    clearInterval(this.softDeletedGroupsCleanupInterval);
  }

  /**
   * Detect devices whose membership hasn't been touched within the message
   * retention window.  Once their queued messages have been garbage-collected,
   * they can no longer catch up by processing missed commits - the only
   * recovery path is a full re-invite (reset to "pending").
   *
   * Only devices in "welcome_received" state are candidates: they were once
   * active but have gone silent for longer than the retention TTL.
   */
  private async detectStaleDevices() {
    const staleDate = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);

    const staleMembers = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .where('dgm.status = :status', { status: 'active' })
      .andWhere('dgm.updatedAt < :staleDate', { staleDate })
      .getMany();

    for (const member of staleMembers) {
      // Remettre en pending (pas en stale supprimé) — le device devra se ré-inviter.
      member.status = 'pending';
      member.lastEpochSeen = 0;
      await this.deviceGroupRepo.save(member);
      await this.redis.srem(
        `group:members:${member.groupId}`,
        `${member.userId}:${member.deviceId}`,
      );
      this.logger.log(
        `[CRON] Stale device reset: device=${member.deviceId} group=${member.groupId} ` +
          `(lastUpdate=${member.updatedAt.toISOString()})`,
      );
    }

    if (staleMembers.length > 0) {
      this.logger.log(
        `[CRON] detectStaleDevices: ${staleMembers.length} device(s) reset to pending`,
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
   * Delete KeyPackages older than 30 days whose device has no active
   * group membership (status = welcome_received). These are leftover
   * packages published by devices that went offline permanently.
   */
  private async cleanupExpiredKeyPackages() {
    const KEY_PACKAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const expiry = new Date(Date.now() - KEY_PACKAGE_MAX_AGE_MS);

    const expiredPackages = await this.keyPackageRepo.find({
      where: { createdAt: LessThan(expiry) },
    });

    if (expiredPackages.length === 0) return;

    // Keep packages for devices that still have active group memberships
    const deviceIds = [...new Set(expiredPackages.map((kp) => kp.deviceId))];
    const activeDevices = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .select('DISTINCT dgm.deviceId', 'deviceId')
      .where('dgm.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('dgm.status = :status', { status: 'active' })
      .getRawMany<{ deviceId: string }>();

    const activeDeviceIds = new Set(activeDevices.map((d) => d.deviceId));
    const toDelete = expiredPackages.filter(
      (kp) => !activeDeviceIds.has(kp.deviceId),
    );

    if (toDelete.length > 0) {
      await this.keyPackageRepo.delete(toDelete.map((kp) => kp.id));
      this.logger.log(
        `[CRON] cleanupExpiredKeyPackages: deleted ${toDelete.length} package(s)`,
      );
    }
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
}
