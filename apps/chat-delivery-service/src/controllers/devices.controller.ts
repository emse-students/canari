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
  sanitizeQueryValue,
  sanitizeOptionalDeviceName,
  sanitizeOptionalDeviceOs,
  sanitizeOptionalDeviceAppVersion,
} from '../utils/sanitize';
import { RETENTION_WINDOW_MS } from '../retention.constants';

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
    private readonly messagingService: MessagingService,
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
    const existing = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
    });
    const isNew = !existing;
    if (!existing) {
      const keyPackage = this.keyPackageRepo.create({
        userId,
        deviceId,
        keyPackage: keyPackagePayload,
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
          ...(deviceName !== undefined && { deviceName }),
          ...(deviceOs !== undefined && { deviceOs }),
          ...(deviceAppVersion !== undefined && { deviceAppVersion }),
          createdAt: new Date(),
        },
      );
    }

    // Create pending DeviceGroupMembership entries for all groups this user
    // already belongs to.  Without this, getPendingInvitations on other
    // devices won't see the new device and will never send it a Welcome.
    // Uses INSERT ... ON CONFLICT DO NOTHING to tolerate concurrent registerDevice calls.
    const userGroups = await this.groupMemberRepo.find({ where: { userId } });
    let activeGroupIds: string[] = [];
    if (userGroups.length > 0) {
      const groupIds = [...new Set(userGroups.map((gm) => gm.groupId))];
      const activeGroups = await this.groupRepo.find({
        where: { id: In(groupIds), deletedAt: IsNull() },
        select: ['id'],
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
            })),
          )
          .orIgnore()
          .execute();
      }
    }

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] DONE user=${userId} device=${deviceId} isNew=${isNew} pendingGroups=${activeGroupIds.length}`,
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
  @Get('mls/devices/:userId/:deviceId/prekeys/list')
  /**
   * Liste les one-time prekeys publiés d'un device (id + payload base64) afin que le
   * client valide localement, KeyPackage par KeyPackage, lesquels il possède encore en
   * clé privée - puis purge les orphelins via {@link pruneDevicePrekeys}.
   */
  async listDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<{ id: string; keyPackage: string }[]> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const rows = await this.oneTimeKeyPackageRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: ['id', 'keyPackage'],
    });
    return rows.map((r) => ({ id: r.id, keyPackage: r.keyPackage }));
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/devices/:userId/:deviceId/prekeys/prune')
  /**
   * Supprime des one-time prekeys ciblés par id (les orphelins dont le client n'a plus
   * la clé privée locale). Borné au couple (userId, deviceId) pour empêcher toute
   * suppression croisée entre devices.
   */
  async pruneDevicePrekeys(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Body() body: { ids: unknown },
  ): Promise<{ status: string; deleted: number }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
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
      `[PRUNE_PREKEYS] user=${safeUserId} device=${safeDeviceId} deleted=${result.affected ?? 0}`,
    );
    return { status: 'pruned', deleted: result.affected ?? 0 };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/devices/:userId/:deviceId')
  /** Completely delete a device from the user's account. Purges all per-device state (memberships, KeyPackages, OneTimeKeyPackages, push tokens, queued messages) and denylists the device against immediate re-registration. */
  async deleteDevice(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // 1. Purge toute l'empreinte per-device (helper partagé avec le GC des devices stale).
    const purge = await this.messagingService.purgeDeviceFootprint(
      safeUserId,
      safeDeviceId,
    );

    // 2. Denylister le device pour empêcher une ré-registration immédiate (spécifique
    //    à la suppression explicite ; le GC ne denyliste pas).
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
      `[DELETE_DEVICE] user=${safeUserId} device=${safeDeviceId} groupsCleaned=${purge.groupsCleaned} keyPackagesDeleted=${purge.keyPackagesDeleted} oneTimeKeyPackagesDeleted=${purge.oneTimeKeyPackagesDeleted} queuedMessagesDeleted=${purge.queuedMessagesDeleted}`,
    );

    return {
      status: 'device_deleted',
      ...purge,
    };
  }
}
