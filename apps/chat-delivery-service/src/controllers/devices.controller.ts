import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Inject,
  Headers,
  BadRequestException,
  NotFoundException,
  UseGuards,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, DataSource, In, IsNull } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import {
  sanitizeIdentityValue,
  sanitizeQueryValue,
  sanitizeOptionalDeviceName,
  sanitizeOptionalDeviceOs,
  sanitizeOptionalNotAfter,
  sanitizeOptionalDeviceAppVersion,
  assertCallerOwnsUserId,
} from '../utils/sanitize';
import {
  RETENTION_WINDOW_MS,
  MAX_DEVICES_PER_USER,
  DEVICE_ENROLMENT_GRACE_MS,
} from '../retention.constants';
import { resolveUserDisplayName } from '../utils/display-name';
import { activeRevocationWhere } from '../utils/revocation';

/**
 * Why a device cannot be handed a KeyPackage right now - and whether that is for ever.
 *
 * `revoked` is final. `unregistered` means nothing was ever published for this user/device pair.
 * `expired` is TEMPORARY and is the one worth naming: the device repairs itself on its next
 * connection (`heldLastResortKeyPackage` refuses to offer an elapsed package, so the round falls
 * through to a fresh mint), and `registerDevice` then re-creates the pending membership for every
 * group its owner is already in.
 */
export type KeyPackageRefusal = 'revoked' | 'unregistered' | 'expired';

/** Either a package to serve, or {@link KeyPackageRefusal} saying why there is none. */
export type KeyPackageResolution = { keyPackage: string } | { refusal: KeyPackageRefusal };

/** Device registration, key packages, device metadata, and device deletion. */
@Controller()
export class DevicesController {
  private readonly logger = new Logger(DevicesController.name);

  constructor(
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private oneTimeKeyPackageRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group)
    private groupRepo: Repository<Group>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly messagingService: MessagingService
  ) {}

  /**
   * Counts the devices of `userId` that are ALIVE, which is what {@link MAX_DEVICES_PER_USER}
   * bounds. `excludeDeviceId` is the device being registered: it is already paid for and must not
   * refuse itself.
   *
   * A device is alive when it holds an ACTIVE group membership or a push token - the two facts the
   * server holds that are written as a consequence of the device working, and the two that cost the
   * resource the cap exists for. Anything else it enrolled within
   * {@link DEVICE_ENROLMENT_GRACE_MS} still counts, so a burst of registrations cannot mint rows
   * without bound before any of them has had to prove anything.
   *
   * WHAT THIS REPLACES, and why the old rule could not be repaired in place: it counted
   * `key_package` rows inside the 90-day retention window, so the number it compared against the
   * limit was the account's ENROLMENT ATTEMPTS, not its devices. Every failed enrolment made the
   * next one likelier to be refused, which is the wrong direction for a defence - and on production
   * it had exactly one victim, an account whose fifteen enrolments carried zero memberships and
   * zero push tokens (2026-09-12).
   *
   * `updatedAt` on either table is deliberately NOT consulted. A liveness clock must be written by
   * the thing whose liveness it measures, and both of those are written by whatever last touched
   * the row - the server included.
   */
  private async countLiveDevices(userId: string, excludeDeviceId: string): Promise<number> {
    const graceCutoff = new Date(Date.now() - DEVICE_ENROLMENT_GRACE_MS);
    const rows = await this.keyPackageRepo
      .createQueryBuilder('kp')
      .select('COUNT(DISTINCT kp."deviceId")', 'n')
      .where('kp."userId" = :userId', { userId })
      .andWhere('kp."deviceId" != :excludeDeviceId', { excludeDeviceId })
      .andWhere(
        `(kp."createdAt" >= :graceCutoff
          OR EXISTS (SELECT 1 FROM dm_device_group_memberships m
                      WHERE m."userId" = kp."userId" AND m."deviceId" = kp."deviceId"
                        AND m.status = 'active')
          OR EXISTS (SELECT 1 FROM push_token p
                      WHERE p."userId" = kp."userId" AND p."deviceId" = kp."deviceId"))`,
        { graceCutoff }
      )
      .getRawOne<{ n: string }>();
    return Number(rows?.n ?? 0);
  }

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Pops one usable OTKP for a device, or returns the static registration KeyPackage.
   *
   * **THE THREE WAYS THIS ANSWERS "NO" ARE THREE DIFFERENT FACTS, SO IT RETURNS WHICH ONE.** It
   * used to return `null` for all of them, and every caller past this point could then only say
   * "not found" - which is how a device holding an elapsed package came to be reported to its
   * inviter as DEREGISTERED, and acted on as one. A distinction carried in prose is a distinction
   * exactly one call site will make; this one is carried as a type, from where it is known.
   *
   * The three differ in what the caller may expect next, which is the whole reason to tell them
   * apart: `revoked` is final, `unregistered` means nothing was ever published for this pair, and
   * `expired` is TEMPORARY - the device mints a fresh package and re-registers on its next
   * connection, and `registerDevice` re-creates the pending membership for every group its owner is
   * already in.
   *
   * THE STATIC ROW IS SERVED TO EVERY CALLER, UNCHANGED, UNTIL THE DEVICE RECONNECTS - which is
   * why the client mints it with the MLS `last_resort` extension (`mintKeyPackages`). An ordinary
   * KeyPackage loses its private bundle at the first Welcome built on it, so before 2026-09-06 the
   * second peer served this row built a Welcome the device could never process: ten groups
   * re-added at once on a Mi 9T produced one join and nineteen `NoMatchingKeyPackage` refusals,
   * and the device re-asked for a Welcome for ever. See
   * `frontend/mls-core/tests/last_resort_key_package.rs`.
   */
  private async resolveKeyPackagePayloadForDevice(
    userId: string,
    deviceId: string
  ): Promise<KeyPackageResolution> {
    const revoked = await this.revokedDeviceRepo.findOne({
      where: activeRevocationWhere({ userId, deviceId }),
    });
    if (revoked) return { refusal: 'revoked' };

    const device = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
    });
    if (!device) return { refusal: 'unregistered' };

    const otkp = await this.dataSource.transaction(async (manager) => {
      const found = await manager
        .getRepository(OneTimeKeyPackage)
        .createQueryBuilder('otkp')
        .where('otkp.userId = :userId AND otkp.deviceId = :deviceId', {
          userId,
          deviceId,
        })
        // AN ELAPSED PACKAGE IS NOT A PACKAGE, and serving one used to cost the row as well as the
        // join: the DELETE below runs whether or not the peer can use what it was handed, so 171
        // aged rows in front of a valid one meant the valid one was reached on the 171st attempt.
        // A NULL is a row from before migration 024 on a table that backfills exactly, so it means
        // "not known to be expired" rather than "assume the worst".
        .andWhere('(otkp."notAfter" IS NULL OR otkp."notAfter" > now())')
        // NEAREST TO EXPIRY FIRST, which is only correct now that the line above excludes the
        // elapsed ones: of the packages that can still be used, spending the shortest-lived first
        // is what stops it elapsing unused. `createdAt ASC` said the same thing by proxy and said it
        // wrong, because it could not tell "oldest" from "already dead".
        .orderBy('otkp."notAfter"', 'ASC', 'NULLS LAST')
        .addOrderBy('otkp.createdAt', 'ASC')
        .limit(1)
        // typeorm 1.0 removed 'pessimistic_partial_write' mode: express
        // FOR UPDATE SKIP LOCKED via setLock('pessimistic_write') + setOnLocked.
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (found) {
        await manager.delete(OneTimeKeyPackage, found.id);
        return found;
      }
      return null;
    });

    // AN EMPTY POOL IS A FACT SOMEBODY SHOULD KNOW, not just a branch. It means this device is
    // being added faster than it reconnects to replenish, or that its client stopped replenishing
    // at all - and the second is invisible from here in any other way. The fallback is correct
    // (it is reusable by construction), so this accuses the pool, not the join.
    if (!otkp) {
      this.logger.warn(
        `[KP] one-time pool EMPTY for ${userId}/${deviceId} - serving the static last-resort row`
      );
    }
    if (otkp) return { keyPackage: otkp.keyPackage };

    // AND A REFUSAL IS AN ANSWER, WHERE A DEAD PACKAGE IS NOT. Serving a last-resort row the server
    // KNOWS has elapsed puts the adder into a loop it cannot see the end of: the joiner rejects it
    // with `LifetimeError(Expired)`, the invitation is neither satisfied nor abandoned, and it
    // retries on every launch for ever - measured on production 2026-09-16, on both boots of one
    // export, four requests and a crypto round each time. Returning null makes the endpoint 404, so
    // the adder gets something it can act on. Nothing here can conjure a valid package for a device
    // that has not connected since its own elapsed; what it can do is stop pretending.
    if (device.notAfter && device.notAfter.getTime() <= Date.now()) {
      this.logger.warn(
        `[KP] last-resort EXPIRED for ${userId}/${deviceId} (notAfter=${device.notAfter.toISOString()})` +
          ' - refusing rather than serving a package no peer can build a Welcome on'
      );
      return { refusal: 'expired' };
    }
    return { keyPackage: device.keyPackage };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/register-device')
  /** Registers a new device (KeyPackage + deviceId) on the server. */
  async registerDevice(
    @Body()
    body: {
      userId: string;
      deviceId: string;
      keyPackage: string;
      /** ISO 8601, the package's own MLS lifetime end. Absent from clients older than 2026-09-16. */
      notAfter?: unknown;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    // IDENTITIES, not query values: this path creates a KeyPackage and a `pending` membership in
    // every group the user is in, so a placeholder accepted here becomes addressable and can then
    // be vouched `active` (see `sanitizeIdentityValue`).
    const userId = sanitizeIdentityValue(body.userId, 'userId');
    const deviceId = sanitizeIdentityValue(body.deviceId, 'deviceId');
    // A device may only register under its own account (audit S2): binding to the HMAC-bound
    // x-user-id prevents an attacker from registering a device under a victim's userId, which
    // would auto-provision pending memberships for the victim's groups and phish Welcomes.
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      userId,
      'Cannot register a device for another user'
    );
    // A deleted device is denylisted for good, and `resolveDeviceId` deliberately restores the
    // SAME id after a reinstall - so without this check the row is written, 200 is returned, and
    // the device is then filtered out of getUserDevices and resolves to a null KeyPackage
    // forever: registered, invisible, never invitable, with no error anywhere. Refusing here is
    // what makes revocation mean something; the client answers by enrolling under a fresh id.
    const revoked = await this.revokedDeviceRepo.findOne({
      where: activeRevocationWhere({ userId, deviceId }),
    });
    if (revoked) {
      this.logger.warn(
        `[REGISTER_DEVICE] REFUSED revoked device user=${userId} device=${deviceId}`
      );
      throw new ForbiddenException({
        code: 'DEVICE_REVOKED',
        message: 'This device was revoked. Enrol again under a new device id.',
      });
    }

    if (
      typeof body.keyPackage !== 'string' ||
      body.keyPackage.trim().length === 0 ||
      body.keyPackage.length > 16384
    ) {
      throw new BadRequestException('keyPackage must be a non-empty base64 string');
    }
    const keyPackagePayload = body.keyPackage;
    // THE DATE BELONGS TO THE PAYLOAD AND IS WRITTEN WITH IT, ALWAYS - including when it is null.
    // The static row is UPDATED in place, and the one case that matters is a device whose
    // last-resort package elapsed and which has therefore minted a NEW one: leaving the previous
    // date behind would refuse a package that works. `notAfter` is a property of `keyPackage`, not
    // of the row, so the two never move apart.
    const notAfter = sanitizeOptionalNotAfter(body.notAfter);
    const deviceName = sanitizeOptionalDeviceName(body.deviceName);
    const deviceOs = sanitizeOptionalDeviceOs(body.deviceOs);
    const deviceAppVersion = sanitizeOptionalDeviceAppVersion(body.deviceAppVersion);

    // Enforce the per-user device limit (M5) against LIVE devices - see countLiveDevices for what
    // that means and why the old row count was the wrong quantity. The device being registered is
    // excluded: re-registering an id the account already holds adds nothing, and counting it
    // refused exactly the devices that were already paid for.
    const deviceCount = await this.countLiveDevices(userId, deviceId);
    if (deviceCount >= MAX_DEVICES_PER_USER) {
      // A REFUSAL NOBODY COULD SEE. Until 2026-08-28 this threw a bare sentence and logged nothing at
      // all - it fires BEFORE the `[REGISTER_DEVICE] START` line below, so a full account produced a
      // 400 with no server trace and a client console reading "welcome_request deferred to next
      // connection". A device in that state holds a session, has no KeyPackage, is refused
      // `[MEMBERSHIP_ACTIVE] reason=no_key_package` in every group, and can never heal. It cost a
      // whole HEAL rung a night and was written up as a product defect that did not exist.
      //
      // THE CODE IS THE POINT, not the message: a 400 here is terminal (the account must lose a
      // device first) while other 400s and every 5xx are retryable, and a client must not tell those
      // apart by reading prose - `DEVICE_LIMIT_REACHED` is what `DeviceLimitReachedError` is thrown on.
      this.logger.warn(
        `[REGISTER_DEVICE] REFUSED device cap user=${userId} device=${deviceId} live=${deviceCount}/${MAX_DEVICES_PER_USER}`
      );
      throw new BadRequestException({
        code: 'DEVICE_LIMIT_REACHED',
        message: `Maximum ${MAX_DEVICES_PER_USER} devices per user reached. Delete an unused device in Settings first.`,
        max: MAX_DEVICES_PER_USER,
      });
    }

    const traceId = this.makeTraceId('reg-device');

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] START user=${userId} device=${deviceId} kpLen=${keyPackagePayload.length}` +
        ` notAfter=${notAfter ? notAfter.toISOString() : 'unknown'}`
    );
    const existing = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
    });
    const isNew = !existing;
    if (!existing) {
      const keyPackage = this.keyPackageRepo.create({
        userId,
        deviceId,
        keyPackage: keyPackagePayload,
        notAfter,
        deviceName,
        deviceOs,
        deviceAppVersion,
        createdAt: new Date(),
      });
      await this.keyPackageRepo.save(keyPackage);
    } else {
      // Use update() instead of save() : TypeORM's SubjectChangedColumnsComputer
      // skips @CreateDateColumn fields in UPDATE queries (isCreateDate = true),
      // so save() would leave createdAt unchanged. Devices re-registering after
      // > 30 days would stay invisible to getUserDevices (30-day cutoff on createdAt).
      await this.keyPackageRepo.update(
        { userId, deviceId },
        {
          keyPackage: keyPackagePayload,
          notAfter,
          ...(deviceName !== undefined && { deviceName }),
          ...(deviceOs !== undefined && { deviceOs }),
          ...(deviceAppVersion !== undefined && { deviceAppVersion }),
          createdAt: new Date(),
        }
      );
    }

    // Create pending DeviceGroupMembership entries for all groups this user
    // already belongs to.  Without this, getPendingInvitations on other
    // devices won't see the new device and will never send it a Welcome.
    // Uses INSERT … ON CONFLICT DO NOTHING to tolerate concurrent registerDevice calls.
    const userGroups = await this.groupMemberRepo.find({ where: { userId } });
    let activeGroupIds: string[] = [];
    if (userGroups.length > 0) {
      const groupIds = [...new Set(userGroups.map((gm) => gm.groupId))];
      const activeGroups = await this.groupRepo.find({
        where: { id: In(groupIds), deletedAt: IsNull() },
        select: { id: true },
      });
      activeGroupIds = activeGroups.map((g) => g.id);
      if (activeGroupIds.length > 0) {
        await this.deviceGroupRepo
          .createQueryBuilder()
          .insert()
          .into(DeviceGroupMembership)
          .values(
            activeGroupIds.map((groupId) => ({
              userId,
              deviceId,
              groupId,
              status: 'pending' as const,
            }))
          )
          .orIgnore()
          .execute();
      }
    }

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] DONE user=${userId} device=${deviceId} isNew=${isNew} pendingGroups=${activeGroupIds.length}`
    );
    return { status: 'registered' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/register-device/prekeys')
  /** Bulk-uploads one-time prekeys for the current device. */
  async registerDevicePrekeys(
    @Body() body: { userId: string; deviceId: string; keyPackages: unknown },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const userId = sanitizeQueryValue(body.userId, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    // Prekeys may only be uploaded for the caller's own account (audit S2).
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      userId,
      'Cannot upload prekeys for another user'
    );

    if (!Array.isArray(body.keyPackages) || body.keyPackages.length === 0) {
      throw new BadRequestException('keyPackages must be a non-empty array');
    }
    if (body.keyPackages.length > 200) {
      throw new BadRequestException('keyPackages must not exceed 200 items');
    }

    // A UNION FOR EXACTLY ONE RELEASE, and the bare string is the OLD half. A client from before
    // 2026-09-16 sends `["base64", ...]` and cannot be made to send anything else; one from after
    // sends `[{ keyPackage, notAfter }, ...]` because the server cannot parse an MLS KeyPackage and
    // so could not tell an elapsed one from a fresh one. The old spelling stores a NULL, which the
    // resolver reads as "not known to be expired" - no device is locked out by a fact nobody has.
    // The removal date is on `docs/wiki/legacy-compatibility.md`.
    const parsed = body.keyPackages.map((entry) => {
      const raw: unknown =
        typeof entry === 'object' && entry !== null ? entry : { keyPackage: entry };
      const { keyPackage, notAfter } = raw as { keyPackage?: unknown; notAfter?: unknown };
      if (typeof keyPackage !== 'string' || keyPackage.length === 0 || keyPackage.length > 16384) {
        throw new BadRequestException('Each keyPackage must be a non-empty base64 string');
      }
      return { keyPackage, notAfter: sanitizeOptionalNotAfter(notAfter) };
    });

    const rows = parsed.map((kp) =>
      this.oneTimeKeyPackageRepo.create({
        userId,
        deviceId,
        keyPackage: kp.keyPackage,
        notAfter: kp.notAfter,
      })
    );
    await this.oneTimeKeyPackageRepo.save(rows);
    // THE UNDATED COUNT IS WHAT SAYS THE SHIM IS STILL EARNING ITS KEEP. It is the only signal that
    // separates "old clients are still out there" from "the union can go", and a removal date with
    // no measurement behind it is a guess.
    const undated = parsed.filter((kp) => kp.notAfter === null).length;
    this.logger.log(
      `[REGISTER_PREKEYS] user=${userId} device=${deviceId} count=${rows.length} undated=${undated}`
    );
    return { status: 'registered', count: rows.length };
  }

  @UseGuards(HeaderAuthGuard)
  @Patch('mls/devices/:userId/:deviceId/metadata')
  /** Updates device display metadata (name, OS, app version). */
  async updateDeviceMetadata(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Body()
    body: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    // A device's metadata may only be edited by its owner (audit S4): the userId is a path
    // param, so without this binding any authenticated user could rewrite another user's
    // device name/OS. Admins exempt; legacy no-op when x-user-id absent.
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot update another user device metadata'
    );
    const deviceName = sanitizeOptionalDeviceName(body.deviceName);
    const deviceOs = sanitizeOptionalDeviceOs(body.deviceOs);
    const deviceAppVersion = sanitizeOptionalDeviceAppVersion(body.deviceAppVersion);

    if (deviceName === undefined && deviceOs === undefined && deviceAppVersion === undefined) {
      throw new BadRequestException('At least one metadata field is required');
    }

    const keyPackage = await this.keyPackageRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    if (!keyPackage) {
      // 404, NOT 400: the request was well formed and the row is simply not there. The 400s in
      // this controller all accuse the CALLER of sending something wrong (an empty body, a
      // non-base64 key package, more than 200 ids), and one of them - the device cap - is
      // TERMINAL where the others are retryable. A client that has to tell those apart without
      // reading prose can only do it if "absent" never borrows their code.
      throw new NotFoundException('Device not found');
    }

    if (deviceName !== undefined) keyPackage.deviceName = deviceName;
    if (deviceOs !== undefined) keyPackage.deviceOs = deviceOs;
    if (deviceAppVersion !== undefined) {
      keyPackage.deviceAppVersion = deviceAppVersion;
    }
    await this.keyPackageRepo.save(keyPackage);

    return {
      status: 'updated',
      deviceName: keyPackage.deviceName ?? null,
      deviceOs: keyPackage.deviceOs ?? null,
      deviceAppVersion: keyPackage.deviceAppVersion ?? null,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId/:deviceId/key-package')
  /**
   * Returns one consumable KeyPackage for a specific device (invite / welcome flows).
   * Unlike the user device list, there is no 30-day cutoff - only revoked / missing devices 404.
   */
  async getDeviceKeyPackage(@Param('userId') userId: string, @Param('deviceId') deviceId: string) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const resolved = await this.resolveKeyPackagePayloadForDevice(safeUserId, safeDeviceId);
    if ('refusal' in resolved) {
      // The resolver refuses in exactly three cases and the docblock above names all of them. None
      // is a malformed request - see the sibling refusal in `updateDeviceMetadata` for why "absent"
      // gets its own code here - and all three are a 404 on purpose: a 404 is the answer a caller
      // can act on, where serving a package every joiner is entitled to refuse is an invitation
      // that retries for ever.
      //
      // WHICH OF THE THREE TRAVELS IN THE BODY, because the caller does different things with them
      // and could not tell them apart. `expired` in particular is temporary and says so: the
      // inviter used to log it as "deregistered" and delete the pending membership on it.
      throw new NotFoundException({
        statusCode: 404,
        message: `No key package for device ${safeUserId}:${safeDeviceId}`,
        reason: resolved.refusal,
      });
    }
    const row = await this.keyPackageRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    return {
      deviceId: safeDeviceId,
      keyPackage: resolved.keyPackage,
      deviceName: row?.deviceName ?? undefined,
      deviceOs: row?.deviceOs ?? undefined,
      deviceAppVersion: row?.deviceAppVersion ?? undefined,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId')
  /** Lists all registered devices for a user, including their key packages (within the retention window). */
  async getUserDevices(@Param('userId') userId: string) {
    // Only return devices seen within the retention window. Aligned with the
    // staleness / key-package retention so a still-recoverable device stays a valid
    // invite target (a device reset to stale only past the same window is otherwise
    // visible here but missing from new-group invites).
    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const registeredDevices = await this.keyPackageRepo.find({
      where: { userId, createdAt: MoreThanOrEqual(cutoff) },
      order: { createdAt: 'DESC' },
    });

    const revokedRows = await this.revokedDeviceRepo.find({
      where: activeRevocationWhere({ userId }),
    });
    const revokedSet = new Set(revokedRows.map((r) => r.deviceId));
    const activeDevices = registeredDevices.filter((d) => !revokedSet.has(d.deviceId));

    // Resolve display name once for the user (all devices share the same owner).
    const displayName = (await resolveUserDisplayName(this.dataSource.manager, userId)) || null;

    const results = await Promise.all(
      activeDevices.map(async (device) => {
        const resolved = await this.resolveKeyPackagePayloadForDevice(
          device.userId,
          device.deviceId
        );
        // A DEVICE WITH NOTHING USABLE IS NOT AN INVITE TARGET, and dropping it here is what makes
        // the refusal reach a person: the client throws "no active device found" rather than
        // building a Welcome on an elapsed package and watching the joiner refuse it on every
        // launch. The device returns to the list by itself - it mints and re-registers on its next
        // connection, and `registerDevice` re-creates the pending membership for every group its
        // owner is already in.
        if ('refusal' in resolved) return null;
        return { ...device, keyPackage: resolved.keyPackage, displayName };
      })
    );

    return results.filter((row): row is NonNullable<typeof row> => row !== null);
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId/:deviceId/revoked')
  /**
   * Says whether a device is currently denylisted.
   *
   * Exists to GATE A DESTRUCTIVE ACTION on a server fact. The `device_revoked` control frame tells
   * a connected device to wipe itself and sign out, and a frame is a message, not an authority - so
   * the client asks this over its authenticated channel before destroying anything. Cheap, one
   * indexed row, and the answer is the same one every other revocation check reads.
   */
  async isDeviceRevoked(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot read another user devices'
    );
    const revoked = await this.revokedDeviceRepo.findOne({
      where: activeRevocationWhere({ userId: safeUserId, deviceId: safeDeviceId }),
    });
    return { revoked: revoked !== null };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId/:deviceId/prekeys/count')
  /** Returns the count of available one-time prekeys for a device. */
  async getPrekeyCount(@Param('userId') userId: string, @Param('deviceId') deviceId: string) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    // PACKAGES THAT CAN BE USED, WHICH IS THE QUESTION THE CALLER ASKS. The client mints
    // `50 - count` on every connection, so counting elapsed rows as available is how a device ends
    // up with a pool of fifty that every peer is refused. Expired rows are left to the reclaim
    // rather than deleted here: a read endpoint that deletes is a surprise, and the sweep says how
    // many it took.
    const count = await this.oneTimeKeyPackageRepo
      .createQueryBuilder('otkp')
      .where('otkp.userId = :userId AND otkp.deviceId = :deviceId', {
        userId: safeUserId,
        deviceId: safeDeviceId,
      })
      .andWhere('(otkp."notAfter" IS NULL OR otkp."notAfter" > now())')
      .getCount();
    return { count };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/devices/:userId/:deviceId/prekeys')
  /**
   * Purges all one-time prekeys for a device, AND REPORTS WHICH ONES IT REMOVED.
   *
   * ## Why the payloads come back, and why they are the only safe reclaim signal
   *
   * The client keeps a private bundle for every prekey it publishes, and until 2026-09-09 nothing
   * ever deleted one: this endpoint emptied the server and the device kept the whole abandoned pool
   * for the 84 days until its lifetimes elapsed. `republishKeyMaterial` calls this once per 30 s
   * during a `NoMatchingKeyPackage` storm, so each round orphaned fifty bundles. Measured on a
   * Mi 9T on 2026-09-09: 2782 one-time bundles against a pool of fifty, ~2 364 bytes each, two
   * thirds of a 10.7 MB state, and none of it yet expired.
   *
   * The device cannot work out the set for itself. `resolveKeyPackagePayloadForDevice` DELETES a
   * row as it hands it out, so "absent from the server" means either "a peer is about to send the
   * Welcome built on it" or "its owner revoked it" - opposite treatments, and guessing loses a
   * join. A row THIS endpoint deletes is unambiguous: it was still in the pool, which is the same
   * as never having been handed out.
   *
   * ## DELETE ... RETURNING, and not a read followed by a delete
   *
   * The obvious implementation - select the rows, then delete them - reintroduces the very race it
   * is meant to close: a peer claiming a prekey between the two statements would have it reported
   * as purged, and the client would then forget the one private bundle that Welcome needs. One
   * statement makes the returned set exactly the deleted set, and a concurrent hand-out either
   * committed first (the row is gone and is not returned) or waits.
   */
  async purgeDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string; deleted: number; keyPackages: string[] }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    // Prekeys may only be purged for the caller's own device (audit S4): purging a victim's
    // one-time KeyPackages would degrade their invite availability. Admins exempt.
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot purge another user device prekeys'
    );
    const result = await this.oneTimeKeyPackageRepo
      .createQueryBuilder()
      .delete()
      .from(OneTimeKeyPackage)
      .where('userId = :userId AND deviceId = :deviceId', {
        userId: safeUserId,
        deviceId: safeDeviceId,
      })
      .returning(['keyPackage'])
      .execute();

    const rows = (result.raw ?? []) as Array<{ keyPackage?: string }>;
    const keyPackages = rows
      .map((r) => r.keyPackage)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
    const deleted = result.affected ?? keyPackages.length;

    // THE TWO NUMBERS ARE LOGGED APART BECAUSE THEY CAN DISAGREE, and the disagreement is the one
    // thing here worth an alert: a driver that stopped returning rows would leave the client
    // reclaiming nothing while this still reported a clean purge, which is the silent return of the
    // leak. Nothing branches on it - a purge that emptied the pool did its job either way.
    if (deleted !== keyPackages.length) {
      this.logger.warn(
        `[PURGE_PREKEYS] user=${safeUserId} device=${safeDeviceId} deleted=${deleted} but only ` +
          `${keyPackages.length} payload(s) came back - the client cannot reclaim what it is not told about`
      );
    }
    this.logger.log(`[PURGE_PREKEYS] user=${safeUserId} device=${safeDeviceId} deleted=${deleted}`);
    return { status: 'purged', deleted, keyPackages };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId/:deviceId/prekeys/list')
  /**
   * Lists published one-time prekeys for a device (id + base64 payload) so the client
   * can locally validate, KeyPackage by KeyPackage, which ones it still holds the
   * private key for - then prune orphans via {@link pruneDevicePrekeys}.
   */
  async listDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string
  ): Promise<{ id: string; keyPackage: string }[]> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const rows = await this.oneTimeKeyPackageRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: { id: true, keyPackage: true },
    });
    return rows.map((r) => ({ id: r.id, keyPackage: r.keyPackage }));
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/devices/:userId/:deviceId/prekeys/prune')
  /**
   * Deletes targeted one-time prekeys by id (orphans for which the client no longer holds
   * the local private key). Scoped to the (userId, deviceId) pair to prevent cross-device
   * deletion.
   */
  async pruneDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Body() body: { ids: unknown },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string; deleted: number }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    // Prekeys may only be pruned for the caller's own device (audit S4). Admins exempt.
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot prune another user device prekeys'
    );
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    if (body.ids.length > 200) {
      throw new BadRequestException('ids must not exceed 200 items');
    }
    for (const id of body.ids) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
        throw new BadRequestException('Each id must be a non-empty string');
      }
    }
    const result = await this.oneTimeKeyPackageRepo.delete({
      id: In(body.ids as string[]),
      userId: safeUserId,
      deviceId: safeDeviceId,
    });
    this.logger.log(
      `[PRUNE_PREKEYS] user=${safeUserId} device=${safeDeviceId} deleted=${result.affected ?? 0}`
    );
    return { status: 'pruned', deleted: result.affected ?? 0 };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/devices/:userId/:deviceId')
  /** Completely delete a device from the user's account. Purges all per-device state (memberships, KeyPackages, OneTimeKeyPackages, push tokens, queued messages) and denylists the device against immediate re-registration. */
  async deleteDevice(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    // A device may only be deleted by its owner (audit S4): this route purges the full
    // per-device footprint (memberships, KeyPackages, queued messages, push token) and
    // denylists re-registration, so without this binding any user could eject a victim from
    // every conversation. Admins exempt; legacy no-op when x-user-id absent.
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot delete another user device'
    );

    // 1. Purge the full per-device footprint (shared helper with the stale-device GC).
    const purge = await this.messagingService.purgeDeviceFootprint(safeUserId, safeDeviceId);

    // 2. Denylist the device to prevent immediate re-registration (explicit deletion only;
    //    the GC does not denylist).
    //    Deliberately NOT filtered by the ban window: this asks "have I already got a row for this
    //    device", which has no age - filtering here would insert a duplicate that the unique
    //    constraint on (userId, deviceId) then rejects, turning a re-revocation into a 500. What
    //    the window changes is the DATE: revoking again restarts it, so a device banned, un-banned
    //    and banned again is banned from today rather than from the first time.
    const existingRevoked = await this.revokedDeviceRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    await this.revokedDeviceRepo.save(
      this.revokedDeviceRepo.create({
        id: existingRevoked?.id ?? crypto.randomUUID(),
        userId: safeUserId,
        deviceId: safeDeviceId,
        revokedAt: new Date(),
      })
    );

    // 3. Tell the device NOW, if it is connected: a delete that leaves a live session open is a
    //    delete the user has to make twice, and the second half is invisible from the panel they
    //    used. The denylist row above is the durable half; this is what makes it immediate.
    const signalled = await this.messagingService.notifyDeviceRevoked(safeUserId, safeDeviceId);

    this.logger.log(
      `[DELETE_DEVICE] user=${safeUserId} device=${safeDeviceId} groupsCleaned=${purge.groupsCleaned} keyPackagesDeleted=${purge.keyPackagesDeleted} oneTimeKeyPackagesDeleted=${purge.oneTimeKeyPackagesDeleted} queuedMessagesDeleted=${purge.queuedMessagesDeleted} signalled=${signalled}`
    );

    return {
      status: 'device_deleted',
      ...purge,
    };
  }
}
