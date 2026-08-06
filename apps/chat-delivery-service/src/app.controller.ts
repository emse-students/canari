import { Controller, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
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
import { initializeApp, getApps, cert, type ServiceAccount } from 'firebase-admin/app';
import { RETENTION_WINDOW_MS, STALE_PENDING_INVITATION_MS } from './retention.constants';
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
  private commitLogPruneInterval: ReturnType<typeof setInterval>;
  private softDeletedGroupsCleanupInterval: ReturnType<typeof setInterval>;
  private cleanupStalePushTokensInterval: ReturnType<typeof setInterval>;
  private cleanupOrphanedMemberRowsInterval: ReturnType<typeof setInterval>;
  private cleanupStalePendingInvitationsInterval: ReturnType<typeof setInterval>;
  private initialSweepTimeout: ReturnType<typeof setTimeout>;

  /**
   * Message retention / stale device TTL. A device is "stale" once its queued
   * messages have expired, meaning it can no longer catch up by processing missed
   * commits. Sourced from the shared {@link RETENTION_WINDOW_MS} so this threshold
   * stays aligned with the device-list cutoff and key-package retention.
   */
  private static readonly MESSAGE_RETENTION_MS = RETENTION_WINDOW_MS;

  /** Grace period before the boot-time GC sweep, so it never competes with the boot path. */
  private static readonly INITIAL_SWEEP_DELAY_MS = 60_000;

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
    private readonly messagingService: MessagingService
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
          this.logger.error('[FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON', e);
        }
      } else {
        this.logger.warn('[FIREBASE] FIREBASE_SERVICE_ACCOUNT_JSON not set - push disabled');
      }
    }

    // Both crons run hourly - there's no point detecting staleness more
    // frequently than the message cleanup that defines it.
    const ONE_HOUR = 60 * 60 * 1000;

    // Detect stale devices: devices whose membership hasn't been updated
    // within MESSAGE_RETENTION_MS are reset to pending for re-invite.
    this.staleDeviceInterval = setInterval(() => {
      void this.detectStaleDevices().catch((e) =>
        this.logger.error('[CRON] detectStaleDevices failed', e)
      );
    }, ONE_HOUR);

    // Cleanup expired queued messages older than MESSAGE_RETENTION_MS
    this.cleanupMessagesInterval = setInterval(() => {
      void this.cleanupExpiredQueuedMessages().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredQueuedMessages failed', e)
      );
    }, ONE_HOUR);

    // Full GC of stale devices: purges the entire footprint (KeyPackages, prekeys,
    // push tokens, queued messages, memberships, Redis) of devices outside the retention
    // window with no active membership. Bounds growth of per-device tables.
    this.cleanupStaleDevicesInterval = setInterval(() => {
      void this.cleanupStaleDevices().catch((e) =>
        this.logger.error('[CRON] cleanupStaleDevices failed', e)
      );
    }, ONE_HOUR);

    // Prune the epoch-indexed MLS commit-log (rung-1 backbone): age window (~1 year) + per-group
    // size cap. Commits are tiny, so a long window keeps replay covering almost every gap.
    this.commitLogPruneInterval = setInterval(() => {
      void this.messagingService
        .pruneExpiredCommitLog()
        .catch((e) => this.logger.error('[CRON] pruneExpiredCommitLog failed', e));
    }, ONE_HOUR);

    // Cleanup orphaned Redis group:members:* keys with no matching DB group
    this.cleanupOrphanedRedisGroupsInterval = setInterval(() => {
      void this.cleanupOrphanedRedisGroups().catch((e) =>
        this.logger.error('[CRON] cleanupOrphanedRedisGroups failed', e)
      );
    }, 6 * ONE_HOUR);

    // Purge soft-deleted group tombstones older than 90 days (once per day)
    this.softDeletedGroupsCleanupInterval = setInterval(() => {
      void this.cleanupSoftDeletedGroups().catch((e) =>
        this.logger.error('[CRON] cleanupSoftDeletedGroups failed', e)
      );
    }, 24 * ONE_HOUR);

    // Purge push tokens not renewed in 90 days (uninstalled / abandoned device)
    this.cleanupStalePushTokensInterval = setInterval(() => {
      void this.cleanupStalePushTokens().catch((e) =>
        this.logger.error('[CRON] cleanupStalePushTokens failed', e)
      );
    }, 24 * ONE_HOUR);

    // Purge "ghost" groups: membership rows referencing a group absent from
    // dm_groups (incomplete/legacy deletion). No other cron catches these, so
    // they would accumulate forever - this guarantees bounded growth.
    this.cleanupOrphanedMemberRowsInterval = setInterval(() => {
      void this.cleanupOrphanedMemberRows().catch((e) =>
        this.logger.error('[CRON] cleanupOrphanedMemberRows failed', e)
      );
    }, 24 * ONE_HOUR);

    // Purge pending memberships stuck past STALE_PENDING_INVITATION_MS: otherwise they
    // are re-listed on every sync (invitation loop that never drains). Deleting the row
    // does not block recovery for a live device (Welcome in queue / welcome_request).
    this.cleanupStalePendingInvitationsInterval = setInterval(() => {
      void this.cleanupStalePendingInvitations().catch((e) =>
        this.logger.error('[CRON] cleanupStalePendingInvitations failed', e)
      );
    }, 24 * ONE_HOUR);

    this.logger.log(
      '[CRON] Stale device detection (1h), message cleanup (1h), ' +
        'stale device GC (1h), orphaned Redis groups cleanup (6h), ' +
        'soft-deleted groups purge (24h), stale push tokens purge (24h), ' +
        'orphaned member rows purge (24h), stale pending invitations purge (24h) scheduled'
    );

    // A `setInterval` FIRES FOR THE FIRST TIME ONE INTERVAL LATER, so a job scheduled every 24 h
    // never runs at all in a service that is redeployed more often than that - and the daily ones
    // here are exactly the purges that bound table growth. Kick each one once, after a short delay
    // so the boot path (migrations, Redis, Firebase) is not competing with a full-table scan.
    this.initialSweepTimeout = setTimeout(() => {
      void this.runInitialSweep().catch((e) => this.logger.error('[CRON] initial sweep failed', e));
    }, AppController.INITIAL_SWEEP_DELAY_MS);
  }

  /**
   * One pass of every GC job, shortly after boot. Sequential on purpose: these are full-table
   * scans, and the point is to bound growth, not to be quick about it.
   */
  private async runInitialSweep() {
    this.logger.log('[CRON] initial sweep: running every GC job once');
    const jobs: [string, () => Promise<unknown>][] = [
      ['detectStaleDevices', () => this.detectStaleDevices()],
      ['cleanupExpiredQueuedMessages', () => this.cleanupExpiredQueuedMessages()],
      ['cleanupStaleDevices', () => this.cleanupStaleDevices()],
      ['cleanupOrphanedRedisGroups', () => this.cleanupOrphanedRedisGroups()],
      ['cleanupSoftDeletedGroups', () => this.cleanupSoftDeletedGroups()],
      ['cleanupStalePushTokens', () => this.cleanupStalePushTokens()],
      ['cleanupOrphanedMemberRows', () => this.cleanupOrphanedMemberRows()],
      ['cleanupStalePendingInvitations', () => this.cleanupStalePendingInvitations()],
      ['pruneExpiredCommitLog', () => this.messagingService.pruneExpiredCommitLog()],
    ];
    for (const [name, run] of jobs) {
      // One failing job must never cost the others their only run of the deployment.
      await run().catch((e) => this.logger.error(`[CRON] initial sweep: ${name} failed`, e));
    }
    this.logger.log('[CRON] initial sweep: done');
  }

  private async ensureDeviceMetadataColumns() {
    const tableName = this.keyPackageRepo.metadata.tableName;
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceName" varchar(80)`
    );
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceOs" varchar(32)`
    );
    await this.keyPackageRepo.query(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "deviceAppVersion" varchar(32)`
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
      )`
    );
    await this.revokedDeviceRepo.query(
      `CREATE INDEX IF NOT EXISTS "IDX_${tableName}_user" ON "${tableName}" ("userId")`
    );
  }

  onModuleDestroy() {
    clearInterval(this.staleDeviceInterval);
    clearInterval(this.cleanupMessagesInterval);
    clearInterval(this.cleanupStaleDevicesInterval);
    clearInterval(this.cleanupOrphanedRedisGroupsInterval);
    clearInterval(this.commitLogPruneInterval);
    clearInterval(this.softDeletedGroupsCleanupInterval);
    clearInterval(this.cleanupStalePushTokensInterval);
    clearInterval(this.cleanupOrphanedMemberRowsInterval);
    clearInterval(this.cleanupStalePendingInvitationsInterval);
    clearTimeout(this.initialSweepTimeout);
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
   * THERE IS NO `updatedAt` PRE-FILTER, and there must never be one again (WP-GHOST-1). It read as
   * a free optimisation - "a row touched within the window is certainly not stale" - and the
   * premise is false: `updatedAt` is a TypeORM `@UpdateDateColumn`, so it answers "when was this
   * row last WRITTEN", and the writers are OTHER people's clients (`sendWelcome`, the commit-path
   * activation, a peer confirming an invitation). Nine devices that no longer existed were kept
   * `active` forever that way on production, all nine sharing an `updatedAt` inside a four-second
   * burst that belonged to somebody else's sync. A liveness clock must be written by the thing
   * whose liveness it measures - here that is `KeyPackage.createdAt`, and it is the only criterion.
   */
  private async detectStaleDevices() {
    const staleDate = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);

    const candidates = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .where('dgm.status = :status', { status: 'active' })
      .getMany();

    if (candidates.length === 0) return;

    // Keep only devices whose KeyPackage is ALSO older than the window, i.e. devices
    // that have not reconnected (republished a KeyPackage) within the retention TTL.
    const deviceIds = [...new Set(candidates.map((m) => m.deviceId))];
    const liveKeyPackages = await this.keyPackageRepo.find({
      where: { deviceId: In(deviceIds), createdAt: MoreThanOrEqual(staleDate) },
      select: { userId: true, deviceId: true },
    });
    const liveDeviceKeys = new Set(liveKeyPackages.map((kp) => `${kp.userId}:${kp.deviceId}`));

    let reset = 0;
    for (const member of candidates) {
      if (liveDeviceKeys.has(`${member.userId}:${member.deviceId}`)) {
        // Device reconnected within the retention window - alive, leave it active.
        continue;
      }
      // Reset to pending - the device will need to receive a new Welcome.
      member.status = 'pending';
      await this.deviceGroupRepo.save(member);
      await this.redis.srem(
        `group:members:${member.groupId}`,
        `${member.userId}:${member.deviceId}`
      );
      reset++;
      // `lastUpdate` is reported because it is EVIDENCE, not because it decided anything: when a
      // demotion looks wrong, the first question is whether somebody else's write kept the row
      // looking fresh, and the answer has to be in the line.
      this.logger.log(
        `[CRON] Stale device reset: device=${member.deviceId} group=${member.groupId} ` +
          `(lastUpdate=${member.updatedAt.toISOString()}, no KeyPackage since ${staleDate.toISOString()})`
      );
    }

    if (reset > 0) {
      this.logger.log(
        `[CRON] detectStaleDevices: ${reset}/${candidates.length} device(s) reset to pending`
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
      this.logger.log(`[CRON] cleanupExpiredQueuedMessages: deleted ${result.affected} message(s)`);
    }
  }

  /**
   * Full GC of stale devices: a device whose static KeyPackage predates the retention
   * window AND has no active membership is considered permanently offline. Its entire
   * server footprint (KeyPackage, one-time prekeys, push tokens, queued messages,
   * device<->group memberships, Redis sets) is purged via the shared
   * {@link MessagingService.purgeDeviceFootprint} helper - the same one used by manual
   * device deletion. Aligned with the retention window so a recoverable device
   * (visible in the list) is never purged prematurely.
   */
  private async cleanupStaleDevices() {
    const expiry = new Date(Date.now() - RETENTION_WINDOW_MS);

    const expiredPackages = await this.keyPackageRepo.find({
      where: { createdAt: LessThan(expiry) },
    });

    // A device with NO KeyPackage row at all can never appear in `expiredPackages`, so enumerating
    // candidates from `key_package` alone made an entire class of device uncollectable - and it is
    // exactly the class that matters (WP-GHOST-1): a device deleted through the product has its
    // KeyPackage purged, and if anything later re-creates its membership rows, nothing on the
    // server can ever reach it again. It is also invisible in `getUserDevices`, which filters on
    // the same table, so its owner cannot delete it a second time either. Enumerate from the
    // memberships too, and treat a missing KeyPackage as terminal rather than as unknown.
    const orphanRows = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .select('DISTINCT dgm.userId', 'userId')
      .addSelect('dgm.deviceId', 'deviceId')
      .where(
        'NOT EXISTS (SELECT 1 FROM key_package kp WHERE kp."deviceId" = dgm."deviceId" AND kp."userId" = dgm."userId")'
      )
      .getRawMany<{ userId: string; deviceId: string }>();

    if (expiredPackages.length === 0 && orphanRows.length === 0) return;

    // Keep devices that still have an active membership - but ONLY those that still exist. The
    // veto is what a live device needs; applying it to a device with no KeyPackage is what let the
    // ghosts sit `active` forever, vetoing their own collection.
    const deviceIds = [...new Set(expiredPackages.map((kp) => kp.deviceId))];
    const activeDevices = deviceIds.length
      ? await this.deviceGroupRepo
          .createQueryBuilder('dgm')
          .select('DISTINCT dgm.deviceId', 'deviceId')
          .where('dgm.deviceId IN (:...deviceIds)', { deviceIds })
          .andWhere('dgm.status = :status', { status: 'active' })
          .getRawMany<{ deviceId: string }>()
      : [];

    const activeDeviceIds = new Set(activeDevices.map((d) => d.deviceId));

    // Deduplicate by (userId, deviceId): a device has only one static KeyPackage,
    // but guard against accidental duplicates.
    const staleDevices = new Map<string, { userId: string; deviceId: string }>();
    for (const kp of expiredPackages) {
      if (activeDeviceIds.has(kp.deviceId)) continue;
      staleDevices.set(`${kp.userId}:${kp.deviceId}`, {
        userId: kp.userId,
        deviceId: kp.deviceId,
      });
    }
    for (const orphan of orphanRows) {
      staleDevices.set(`${orphan.userId}:${orphan.deviceId}`, orphan);
    }

    if (staleDevices.size === 0) return;

    for (const { userId, deviceId } of staleDevices.values()) {
      const purged = await this.messagingService.purgeDeviceFootprint(userId, deviceId);
      this.logger.log(
        `[CRON] cleanupStaleDevices: purged device=${userId}:${deviceId} ` +
          `groups=${purged.groupsCleaned} queued=${purged.queuedMessagesDeleted}`
      );
    }

    this.logger.log(
      `[CRON] cleanupStaleDevices: purged ${staleDevices.size} stale device(s) ` +
        `(${orphanRows.length} of them with no KeyPackage at all)`
    );
  }

  /**
   * Purges device-group invitations left `pending` beyond {@link STALE_PENDING_INVITATION_MS}.
   *
   * A `pending` row is created on invitation and only becomes `active` once the invited device
   * confirms it processed its Welcome. A device that joins the MLS tree but never confirms
   * (lost Welcome, zombie device reconnecting without ever processing its Welcome) leaves its
   * `pending` row forever: `getPendingInvitations` re-lists it on every sync and active members
   * re-process it in a loop (lock acquisition + tree re-read only to skip). The
   * `cleanupStaleDevices` GC does not catch it as long as the device republishes a fresh
   * KeyPackage on every connection.
   *
   * Deleting the `pending` row (+ its Redis routing entry) does NOT prevent a still-alive device
   * from recovering: it remains a user-level `GroupMember`, so on its next connection it rejoins
   * either through its Welcome still queued (separate table, 90d retention - without a new
   * commit), or through `welcome_request`, which triggers a re-add at the current epoch. The
   * threshold is therefore deliberately much shorter than the Welcome retention: it only bounds
   * how long the durable trigger/fallback is kept on the inviter side. `active` rows and
   * `dm_group_members` are never touched.
   *
   * Filters on `updatedAt` (not `createdAt`): a device that was once `active` and then put back
   * to `pending` by {@link detectStaleDevices} thus gets a fresh grace window from its last state
   * transition, aligned with the existing freshness semantics.
   */
  private async cleanupStalePendingInvitations() {
    const expiry = new Date(Date.now() - STALE_PENDING_INVITATION_MS);

    const stale = await this.deviceGroupRepo.find({
      where: { status: 'pending', updatedAt: LessThan(expiry) },
    });

    if (stale.length === 0) return;

    for (const m of stale) {
      await this.deviceGroupRepo.delete({
        userId: m.userId,
        deviceId: m.deviceId,
        groupId: m.groupId,
      });
      await this.redis.srem(`group:members:${m.groupId}`, `${m.userId}:${m.deviceId}`);
    }

    this.logger.log(
      `[CRON] cleanupStalePendingInvitations: purged ${stale.length} stale pending invitation(s)`
    );
  }

  /**
   * Purge soft-deleted group tombstones (deletedAt != null) older than 90 days,
   * along with their GroupMember and DeviceGroupMembership rows.
   * The tombstone is kept for 90 days so that lagging devices can still observe the
   * deletion (deletedAt) and converge; after that the data has no recovery value.
   */
  private async cleanupSoftDeletedGroups() {
    const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - TOMBSTONE_MAX_AGE_MS);

    const deadGroups = await this.groupRepo.find({
      where: { deletedAt: LessThan(cutoff) },
      select: { id: true },
    });

    if (deadGroups.length === 0) return;

    const ids = deadGroups.map((g) => g.id);

    await this.groupMemberRepo.delete({ groupId: In(ids) });
    await this.deviceGroupRepo.delete({ groupId: In(ids) });
    await this.groupRepo.delete(ids);

    this.logger.log(`[CRON] cleanupSoftDeletedGroups: purged ${ids.length} tombstone(s)`);
  }

  /**
   * Purge push tokens whose updatedAt is older than 90 days.
   * A token not renewed for 90 days indicates an uninstalled or abandoned device;
   * continuing to send to it causes avoidable FCM/APNs errors.
   */
  private async cleanupStalePushTokens() {
    const PUSH_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - PUSH_TOKEN_MAX_AGE_MS);
    const result = await this.pushTokenRepo.delete({
      updatedAt: LessThan(cutoff),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `[CRON] cleanupStalePushTokens: deleted ${result.affected} token(s) not renewed in 90 days`
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
        100
      );
      cursor = nextCursor;

      if (keys.length === 0) continue;

      const groupIds = keys.map((k) => k.replace('group:members:', ''));
      const existingGroups = await this.groupRepo.find({
        where: { id: In(groupIds) },
        select: { id: true },
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
      this.logger.log(`[CRON] cleanupOrphanedRedisGroups: deleted ${orphanedKeys.length} key(s)`);
    }
  }

  /**
   * Purge "ghost" groups: membership rows (dm_group_members / dm_device_group_memberships)
   * referencing a group absent from dm_groups.
   *
   * The normal lifecycle (soft-delete -> tombstone -> cleanupSoftDeletedGroups) removes
   * these rows together with the group. But a group deleted via an abnormal/legacy path
   * (partial hard-delete) leaves orphaned memberships that no other cron catches and that
   * would accumulate indefinitely. Full purge (DB rows + Redis history:/group:members:/
   * pending_welcome: keys) is delegated to MessagingService.purgeOrphanGroups to avoid
   * duplicating the logic.
   */
  private async cleanupOrphanedMemberRows() {
    const orphanRows: { groupId: string }[] = await this.groupRepo.query(
      `SELECT DISTINCT m."groupId" FROM dm_group_members m
         LEFT JOIN dm_groups g ON g.id = m."groupId"
        WHERE g.id IS NULL
       UNION
       SELECT DISTINCT d."groupId" FROM dm_device_group_memberships d
         LEFT JOIN dm_groups g ON g.id = d."groupId"
        WHERE g.id IS NULL`
    );

    const orphanIds = orphanRows.map((r) => r.groupId);
    if (orphanIds.length === 0) return;

    await this.messagingService.purgeOrphanGroups(orphanIds);
    this.logger.log(`[CRON] cleanupOrphanedMemberRows: swept ${orphanIds.length} ghost group(s)`);
  }
}
