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
import { Repository, MoreThanOrEqual, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  sanitizeOptionalDeviceName,
  sanitizeOptionalDeviceOs,
  sanitizeOptionalDeviceAppVersion,
} from '../utils/sanitize';

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
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Pops one OTKP (FIFO) for a device, or returns the static registration KeyPackage.
   * Returns null when the device is revoked or has no registered KeyPackage.
   */
  private async resolveKeyPackagePayloadForDevice(
    userId: string,
    deviceId: string,
  ): Promise<string | null> {
    const revoked = await this.revokedDeviceRepo.findOne({
      where: { userId, deviceId },
    });
    if (revoked) return null;

    const device = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
    });
    if (!device) return null;

    const otkp = await this.dataSource.transaction(async (manager) => {
      const found = await manager
        .getRepository(OneTimeKeyPackage)
        .createQueryBuilder('otkp')
        .where('otkp.userId = :userId AND otkp.deviceId = :deviceId', {
          userId,
          deviceId,
        })
        .orderBy('otkp.createdAt', 'ASC')
        .limit(1)
        .setLock('pessimistic_partial_write')
        .getOne();
      if (found) {
        await manager.delete(OneTimeKeyPackage, found.id);
        return found;
      }
      return null;
    });

    return otkp?.keyPackage ?? device.keyPackage;
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
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    },
  ) {
    const userId = sanitizeQueryValue(body.userId, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    if (
      typeof body.keyPackage !== 'string' ||
      body.keyPackage.trim().length === 0 ||
      body.keyPackage.length > 16384
    ) {
      throw new BadRequestException(
        'keyPackage must be a non-empty base64 string',
      );
    }
    const keyPackagePayload = body.keyPackage;
    const deviceName = sanitizeOptionalDeviceName(body.deviceName);
    const deviceOs = sanitizeOptionalDeviceOs(body.deviceOs);
    const deviceAppVersion = sanitizeOptionalDeviceAppVersion(
      body.deviceAppVersion,
    );

    const traceId = this.makeTraceId('reg-device');

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] START user=${userId} device=${deviceId} kpLen=${keyPackagePayload.length}`,
    );
    let keyPackage = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
    });
    const isNew = !keyPackage;
    if (!keyPackage) {
      keyPackage = this.keyPackageRepo.create({
        userId,
        deviceId,
        keyPackage: keyPackagePayload,
        deviceName,
        deviceOs,
        deviceAppVersion,
        createdAt: new Date(),
      });
    } else {
      keyPackage.keyPackage = keyPackagePayload;
      if (deviceName !== undefined) keyPackage.deviceName = deviceName;
      if (deviceOs !== undefined) keyPackage.deviceOs = deviceOs;
      if (deviceAppVersion !== undefined) {
        keyPackage.deviceAppVersion = deviceAppVersion;
      }
      keyPackage.createdAt = new Date();
    }
    await this.keyPackageRepo.save(keyPackage);

    // Create pending DeviceGroupMembership entries for all groups this user
    // already belongs to.  Without this, getPendingInvitations on other
    // devices won't see the new device and will never send it a Welcome.
    const userGroups = await this.groupMemberRepo.find({
      where: { userId },
    });
    for (const gm of userGroups) {
      const existing = await this.deviceGroupRepo.findOne({
        where: { deviceId, groupId: gm.groupId },
      });
      if (!existing) {
        const membership = this.deviceGroupRepo.create({
          userId,
          deviceId,
          groupId: gm.groupId,
          status: 'pending' as const,
        });
        await this.deviceGroupRepo.save(membership);
      }
    }

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] DONE user=${userId} device=${deviceId} isNew=${isNew} pendingGroups=${userGroups.length}`,
    );
    return { status: 'registered' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/register-device/prekeys')
  /** Bulk-uploads one-time prekeys for the current device. */
  async registerDevicePrekeys(
    @Body() body: { userId: string; deviceId: string; keyPackages: unknown },
  ) {
    const userId = sanitizeQueryValue(body.userId, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    if (!Array.isArray(body.keyPackages) || body.keyPackages.length === 0) {
      throw new BadRequestException('keyPackages must be a non-empty array');
    }
    if (body.keyPackages.length > 200) {
      throw new BadRequestException('keyPackages must not exceed 200 items');
    }
    for (const kp of body.keyPackages) {
      if (typeof kp !== 'string' || kp.length === 0 || kp.length > 16384) {
        throw new BadRequestException(
          'Each keyPackage must be a non-empty base64 string',
        );
      }
    }

    const rows = (body.keyPackages as string[]).map((kp) =>
      this.oneTimeKeyPackageRepo.create({ userId, deviceId, keyPackage: kp }),
    );
    await this.oneTimeKeyPackageRepo.save(rows);
    this.logger.log(
      `[REGISTER_PREKEYS] user=${userId} device=${deviceId} count=${rows.length}`,
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
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const deviceName = sanitizeOptionalDeviceName(body.deviceName);
    const deviceOs = sanitizeOptionalDeviceOs(body.deviceOs);
    const deviceAppVersion = sanitizeOptionalDeviceAppVersion(
      body.deviceAppVersion,
    );

    if (
      deviceName === undefined &&
      deviceOs === undefined &&
      deviceAppVersion === undefined
    ) {
      throw new BadRequestException('At least one metadata field is required');
    }

    const keyPackage = await this.keyPackageRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    if (!keyPackage) {
      throw new BadRequestException('Device not found');
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
  async getDeviceKeyPackage(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const keyPackage = await this.resolveKeyPackagePayloadForDevice(
      safeUserId,
      safeDeviceId,
    );
    if (!keyPackage) {
      throw new BadRequestException(
        `No key package for device ${safeUserId}:${safeDeviceId}`,
      );
    }
    const row = await this.keyPackageRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    return {
      deviceId: safeDeviceId,
      keyPackage,
      deviceName: row?.deviceName ?? undefined,
      deviceOs: row?.deviceOs ?? undefined,
      deviceAppVersion: row?.deviceAppVersion ?? undefined,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId')
  /** Lists all registered devices for a user, including their key packages (last 30 days). */
  async getUserDevices(@Param('userId') userId: string) {
    // Only return devices active in the last 30 days (avoids stale key packages)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const registeredDevices = await this.keyPackageRepo.find({
      where: { userId, createdAt: MoreThanOrEqual(cutoff) },
      order: { createdAt: 'DESC' },
    });

    const revokedRows = await this.revokedDeviceRepo.find({
      where: { userId },
    });
    const revokedSet = new Set(revokedRows.map((r) => r.deviceId));
    const activeDevices = registeredDevices.filter(
      (d) => !revokedSet.has(d.deviceId),
    );

    const results = await Promise.all(
      activeDevices.map(async (device) => {
        const keyPackage = await this.resolveKeyPackagePayloadForDevice(
          device.userId,
          device.deviceId,
        );
        if (!keyPackage) return null;
        return { ...device, keyPackage };
      }),
    );

    return results.filter(
      (row): row is NonNullable<typeof row> => row !== null,
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/devices/:userId/:deviceId/prekeys/count')
  /** Returns the count of available one-time prekeys for a device. */
  async getPrekeyCount(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const count = await this.oneTimeKeyPackageRepo.count({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    return { count };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/devices/:userId/:deviceId/prekeys')
  /** Purges all one-time prekeys for a device (used when resetting a device's key material). */
  async purgeDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const result = await this.oneTimeKeyPackageRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });
    this.logger.log(
      `[PURGE_PREKEYS] user=${safeUserId} device=${safeDeviceId} deleted=${result.affected ?? 0}`,
    );
    return { status: 'purged', deleted: result.affected ?? 0 };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/devices/:userId/:deviceId')
  /** Completely delete a device from the user's account. Removes: all group memberships, KeyPackages, OneTimeKeyPackages, and push tokens. */
  async deleteDevice(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // 1. Remove from ALL groups and clean Redis
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: ['groupId'],
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    const memberKey = `${safeUserId}:${safeDeviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    // 2. Delete all KeyPackages for this device
    const kpResult = await this.keyPackageRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    // 3. Delete all OneTimeKeyPackages for this device
    const otkpResult = await this.oneTimeKeyPackageRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    // 4. Delete push token if exists
    await this.pushTokenRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    // 5. Mark device as revoked to prevent immediate re-registration
    const existingRevoked = await this.revokedDeviceRepo.findOne({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    if (!existingRevoked) {
      await this.revokedDeviceRepo.save(
        this.revokedDeviceRepo.create({
          id: crypto.randomUUID(),
          userId: safeUserId,
          deviceId: safeDeviceId,
        }),
      );
    }

    this.logger.log(
      `[DELETE_DEVICE] user=${safeUserId} device=${safeDeviceId} groupsCleaned=${groupIds.length} keyPackagesDeleted=${kpResult.affected ?? 0} oneTimeKeyPackagesDeleted=${otkpResult.affected ?? 0}`,
    );

    return {
      status: 'device_deleted',
      groupsCleaned: groupIds.length,
      keyPackagesDeleted: kpResult.affected ?? 0,
      oneTimeKeyPackagesDeleted: otkpResult.affected ?? 0,
    };
  }
}
