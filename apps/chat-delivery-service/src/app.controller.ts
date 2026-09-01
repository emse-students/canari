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
import {
  RETENTION_WINDOW_MS,
  STALE_PENDING_INVITATION_MS,
  QUEUE_BYTES_WARN_PER_DEVICE,
  QUEUE_DEPTH_WARN_PER_DEVICE,
  QUEUE_DEPTH_REPORT_TOP_N,
  STRANDED_PENDING_MEMBERSHIP_MS,
  STRANDED_MEMBERSHIP_REPORT_TOP_N,
} from './retention.constants';
import { activeRevocationCutoff } from './utils/revocation';
import {
  deleteGroupOwnedRows,
  deleteGroupRedisKeys,
  totalGroupOwnedRows,
} from './utils/group-purge';
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
  private cleanupExpiredRevocationsInterval: ReturnType<typeof setInterval>;
  private reportQueueDepthInterval: ReturnType<typeof setInterval>;
  private reportStrandedMembershipsInterval: ReturnType<typeof setInterval>;
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

    // Reclaim device revocations past DEVICE_REVOCATION_TTL_MS. The ban is enforced at every
    // lookup, so this only frees the space - see cleanupExpiredRevocations.
    this.cleanupExpiredRevocationsInterval = setInterval(() => {
      void this.cleanupExpiredRevocations().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredRevocations failed', e)
      );
    }, 24 * ONE_HOUR);

    // Observe the undelivered queue. Purely a report: it deletes nothing, and it exists because
    // a single device silently accumulated 29 499 frames (39 MB) in five hours on production and
    // nothing said so - the shape was only found by hand, a day later.
    this.reportQueueDepthInterval = setInterval(() => {
      void this.reportQueueDepth().catch((e) =>
        this.logger.error('[CRON] reportQueueDepth failed', e)
      );
    }, ONE_HOUR);

    // Observe the roster. Also purely a report, and it exists for the same reason as the one
    // above: a device registered as a member but never added to the MLS group was found only by
    // reading the tables by hand, 3 h 41 after it stopped being able to receive anything.
    this.reportStrandedMembershipsInterval = setInterval(() => {
      void this.reportStrandedDeviceMemberships().catch((e) =>
        this.logger.error('[CRON] reportStrandedDeviceMemberships failed', e)
      );
    }, ONE_HOUR);

    this.logger.log(
      '[CRON] Stale device detection (1h), message cleanup (1h), ' +
        'stale device GC (1h), queue depth report (1h), stranded membership report (1h), ' +
        'orphaned Redis groups cleanup (6h), ' +
        'soft-deleted groups purge (24h), stale push tokens purge (24h), ' +
        'orphaned member rows purge (24h), stale pending invitations purge (24h), ' +
        'expired device revocations purge (24h) scheduled'
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
      ['cleanupExpiredRevocations', () => this.cleanupExpiredRevocations()],
      ['pruneExpiredCommitLog', () => this.messagingService.pruneExpiredCommitLog()],
      // Last on purpose: they report the estate as the GC leaves it, not as it found it -
      // `cleanupStalePendingInvitations` above is the job that deletes what the second one reads.
      ['reportQueueDepth', () => this.reportQueueDepth()],
      ['reportStrandedDeviceMemberships', () => this.reportStrandedDeviceMemberships()],
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
    clearInterval(this.cleanupExpiredRevocationsInterval);
    clearInterval(this.reportQueueDepthInterval);
    clearInterval(this.reportStrandedMembershipsInterval);
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
   * Report the shape of the undelivered queue, hourly. Deletes nothing.
   *
   * WHY A REPORT AND NOT A CAP. The queue is bounded on exactly one axis, age
   * ({@link cleanupExpiredQueuedMessages}), because that is the only axis on which dropping a
   * frame is defensible: past the retention window the recipient could not have used it anyway.
   * A size cap would trade a disk problem for silent message loss, which is the failure class
   * this whole service exists to prevent. So the answer to "one device is running away" is to
   * NAME it, not to start discarding its mail.
   *
   * WHY IT EXISTS AT ALL. On 2026-08-10 the retransmission storm (WP-RETRANSMIT-1) put 28 124
   * frames on a single web device inside five hours - 39 MB of ciphertext, thirty times the rest
   * of the platform put together - addressed to a browser generation that had already been
   * replaced and would therefore never drain it. Nothing logged, nothing warned; it was found by
   * a manual `GROUP BY deviceId` a day later. Every mechanism involved behaved as designed: the
   * 90-day retention would have collected it in November, and the device held a valid KeyPackage
   * so no ghost predicate applied to it. What was missing was somebody looking.
   *
   * The WARN carries the device's last KeyPackage upload because that is the EVIDENCE that
   * distinguishes the two causes a deep queue can have, and they call for opposite responses:
   * a recent upload means a live device that cannot keep up (WP-PENDING-1, a client bug), while
   * a stale one means a device that will never come back (debris, awaiting the GC). A line
   * reporting only the depth cannot tell them apart and would send the reader to the wrong fix.
   */
  private async reportQueueDepth() {
    const total = await this.queuedMessageRepo.count();
    if (total === 0) {
      this.logger.log('[CRON] reportQueueDepth: queue empty');
      return;
    }

    // Ordered by BYTES, not by row count. A queue is undeliverable when it is too big to cross the
    // link, and rows are a poor proxy for that: on 2026-08-13 a phone sat at 976 frames - under the
    // row threshold, so this report stayed at LOG level for weeks - carrying 36 MB, because a
    // quarter of them held media at up to 89 kB each. Ranking by depth put a harmless 189-frame
    // device above it. The predicate that named the retransmission storm could not name this.
    const deepest = await this.queuedMessageRepo
      .createQueryBuilder('q')
      .select('q.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'depth')
      .addSelect('COALESCE(SUM(LENGTH(q.proto)), 0)', 'bytes')
      .addSelect('MIN(q.createdAt)', 'oldest')
      .groupBy('q.deviceId')
      .orderBy('COALESCE(SUM(LENGTH(q.proto)), 0)', 'DESC')
      .limit(QUEUE_DEPTH_REPORT_TOP_N)
      .getRawMany<{ deviceId: string; depth: string; bytes: string; oldest: Date }>();

    const mb = (bytes: string) => `${(Number(bytes) / 1024 / 1024).toFixed(1)}MB`;
    const summary = deepest.map((r) => `${r.deviceId}=${r.depth}/${mb(r.bytes)}`).join(' ');
    this.logger.log(
      `[CRON] reportQueueDepth: ${total} frame(s) queued, heaviest ${QUEUE_DEPTH_REPORT_TOP_N}: ${summary}`
    );

    // Either axis alone misses a real offender, so the WARN fires on either.
    const runaway = deepest.filter(
      (r) =>
        Number(r.depth) >= QUEUE_DEPTH_WARN_PER_DEVICE ||
        Number(r.bytes) >= QUEUE_BYTES_WARN_PER_DEVICE
    );
    if (runaway.length === 0) return;

    // One extra query rather than one per offender: the WARN list is capped at TOP_N, so this is
    // a single `IN` over at most a handful of ids.
    const liveness = await this.keyPackageRepo.find({
      where: { deviceId: In(runaway.map((r) => r.deviceId)) },
      select: { deviceId: true, createdAt: true },
    });
    const lastSeen = new Map(liveness.map((kp) => [kp.deviceId, kp.createdAt]));

    for (const r of runaway) {
      const seen = lastSeen.get(r.deviceId);
      this.logger.warn(
        `[CRON] reportQueueDepth: device=${r.deviceId} depth=${r.depth} size=${mb(r.bytes)} ` +
          `oldest=${new Date(r.oldest).toISOString()} ` +
          `lastKeyPackage=${seen ? seen.toISOString() : 'none'} ` +
          `(>= ${QUEUE_DEPTH_WARN_PER_DEVICE} frames or ${QUEUE_BYTES_WARN_PER_DEVICE / 1024 / 1024}MB: ` +
          `a live device is falling behind, a stale one is debris)`
      );
    }
  }

  /**
   * Names the devices that hold a group roster seat they were never given the keys for.
   *
   * PURELY A REPORT: it deletes nothing and changes nothing. `cleanupStalePendingInvitations`
   * already purges these rows - fourteen days later, silently, which is why this population could
   * grow for a week and be discovered only by reading the tables by hand.
   *
   * THE PARTITION IS THE POINT, because a `pending` row on its own is evidence for nothing. Two
   * opposite situations wear it: a Welcome sitting in the queue for a device that is merely
   * offline (healthy - the add worked, delivery is owed), and a device `addMembersBulk` SKIPPED
   * for an invalid KeyPackage, which `registerMember` had already given a roster row. The second
   * one is a member to every reader, receives no frame, and raises no notification, for as long as
   * nothing wakes it. The queued Welcome separates them exactly, so it is read rather than
   * guessed - the one fact the row itself cannot carry.
   *
   * Both halves are printed even when the second is empty. The threshold is calibrated on a single
   * incident (see {@link STRANDED_PENDING_MEMBERSHIP_MS}), and a predicate that named one incident
   * has to be re-measured against the population it actually runs on before its name is believed;
   * printing the whole partition is what makes that possible from the log alone.
   */
  private async reportStrandedDeviceMemberships() {
    const cutoff = new Date(Date.now() - STRANDED_PENDING_MEMBERSHIP_MS);
    const pending = await this.deviceGroupRepo.find({
      where: { status: 'pending', updatedAt: LessThan(cutoff) },
    });
    if (pending.length === 0) {
      this.logger.log(
        '[CRON] reportStrandedDeviceMemberships: no pending membership older than ' +
          `${STRANDED_PENDING_MEMBERSHIP_MS / 60000}min`
      );
      return;
    }

    // One grouped query for the whole candidate set rather than one per row: this population is
    // small by construction (it is bounded by the 14-day purge) but it is not bounded per user.
    const welcomed = await this.queuedMessageRepo
      .createQueryBuilder('q')
      .select('q.deviceId', 'deviceId')
      .addSelect('q.groupId', 'groupId')
      .where('q.isWelcome = :isWelcome', { isWelcome: true })
      .andWhere('q.deviceId IN (:...deviceIds)', {
        deviceIds: [...new Set(pending.map((p) => p.deviceId))],
      })
      .groupBy('q.deviceId')
      .addGroupBy('q.groupId')
      .getRawMany<{ deviceId: string; groupId: string }>();

    // ` ` cannot occur in either identifier, so the pair key is unambiguous - a plain `:` or
    // `-` join would be, since a deviceId already contains both.
    const owedAWelcome = new Set(welcomed.map((w) => `${w.deviceId} ${w.groupId}`));
    const stranded = pending.filter((p) => !owedAWelcome.has(`${p.deviceId} ${p.groupId}`));

    this.logger.log(
      `[CRON] reportStrandedDeviceMemberships: ${pending.length} pending membership(s) past the ` +
        `window - ${pending.length - stranded.length} awaiting a queued Welcome, ` +
        `${stranded.length} with no Welcome ever queued`
    );
    if (stranded.length === 0) return;

    // ONE line, not one per row: this fires hourly, and a report whose reader learns to skip it is
    // the one that hides the next defect. The oldest are named because age is what separates a row
    // minted minutes ago from the class that cost a conversation its notifications.
    const named = [...stranded]
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, STRANDED_MEMBERSHIP_REPORT_TOP_N)
      .map((m) => `${m.deviceId}@${m.groupId}(${m.updatedAt.toISOString()})`)
      .join(' ');
    this.logger.warn(
      `[CRON] reportStrandedDeviceMemberships: ${stranded.length} device(s) hold a roster seat ` +
        `with no Welcome ever queued - they were registered as members and never added to the MLS ` +
        `group, so they receive nothing and notify nothing. Oldest ` +
        `${Math.min(stranded.length, STRANDED_MEMBERSHIP_REPORT_TOP_N)}: ${named}`
    );
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
    // `.distinct(true)`, NOT `DISTINCT` inside the first select string: TypeORM does not preserve
    // the order the selects were declared in, so the keyword lands in the middle of the column list
    // and Postgres rejects it (`syntax error at or near "DISTINCT"`, seen on the prod boot sweep).
    // The single-column builders below get away with it only because there is nothing to reorder.
    const orphanRows = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .select('dgm.userId', 'userId')
      .addSelect('dgm.deviceId', 'deviceId')
      .distinct(true)
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
   * Purge soft-deleted group tombstones (deletedAt != null) older than 90 days, along with
   * everything the group owns - {@link deleteGroupOwnedRows} is the single allowlist of that.
   * The tombstone is kept for 90 days so that lagging devices can still observe the
   * deletion (deletedAt) and converge; after that the data has no recovery value.
   *
   * The rows and the `dm_groups` row go in ONE transaction. Until 2026-08-18 this named only the
   * two membership tables and left `mls_group_info`, `mls_commit_log`, `queued_message` and
   * `group_invites` behind for ever - and the sweep meant to catch the remains looks for orphans by
   * joining FROM the membership rows this deletes first, so it was structurally blind to exactly
   * the groups that died normally. Both holes close here.
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

    const counts = await this.groupRepo.manager.transaction(async (tx) => {
      const removed = await deleteGroupOwnedRows(tx, ids);
      await tx.getRepository(Group).delete(ids);
      return removed;
    });

    // After the commit: Redis cannot join the transaction, and a crash here leaves keys that
    // cleanupOrphanedRedisGroups collects - whereas deleting them first would strip a live
    // group's history if the transaction then rolled back.
    await deleteGroupRedisKeys(this.redis, ids);

    this.logger.log(
      `[CRON] cleanupSoftDeletedGroups: purged ${ids.length} tombstone(s) and ` +
        `${totalGroupOwnedRows(counts)} owned row(s): ${JSON.stringify(counts)}`
    );
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
   * Reclaims device revocations past their window.
   *
   * Purely hygiene, and deliberately so: the ban is already enforced by
   * {@link activeRevocationWhere} at every site that asks whether a device is banned, so a row
   * still sitting here bans nobody. That ordering matters - if this job were what enforced the
   * bound, a service that failed to run it would keep banning devices it had promised to release,
   * and nothing would say so. Deleting is what keeps a table that only ever grows from becoming
   * one nobody can reason about.
   */
  private async cleanupExpiredRevocations() {
    const result = await this.revokedDeviceRepo.delete({
      revokedAt: LessThan(activeRevocationCutoff()),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `[CRON] cleanupExpiredRevocations: deleted ${result.affected} revocation(s) past their window`
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
