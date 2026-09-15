/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DevicesController } from './devices.controller';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * A 400 accuses the CALLER of sending something malformed. Two answers in this controller meant
 * "the row is not there" and said 400 anyway - the key-package lookup against its OWN docblock,
 * which promises "only revoked / missing devices 404".
 *
 * The reason it matters is 60 lines above the first of them: the per-user device cap is a 400
 * carrying `DEVICE_LIMIT_REACHED`, and its comment states that a 400 there is TERMINAL while every
 * 5xx is retryable - a client must be able to tell those apart WITHOUT reading prose. Every extra
 * meaning crowded into 400 makes that classification thinner. "Absent" has its own code; it should
 * use it.
 *
 * These cases pin the status, not the sentence. The malformed-body case is here on purpose: it is
 * the control that proves the swap moved the two answers that were wrong and left the one that was
 * right alone.
 */
describe('DevicesController - a missing row is 404, a malformed request stays 400', () => {
  let controller: DevicesController;
  let revokedDeviceRepo: { findOne: jest.Mock };
  let keyPackageRepo: { findOne: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    revokedDeviceRepo = { findOne: jest.fn().mockResolvedValue(null) };
    keyPackageRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
        // No transaction is reachable in these cases: the resolver returns before the OTKP pop.
        { provide: DataSource, useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
  });

  it('answers 404 when the device never registered a key package', async () => {
    await expect(controller.getDeviceKeyPackage('u1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(controller.getDeviceKeyPackage('u1', 'd1')).rejects.toMatchObject({ status: 404 });
  });

  /**
   * The docblock promises 404 for revoked devices too, and the resolver collapses both cases into
   * one null - so both have to be asserted, or the promise is only half kept.
   */
  it('answers 404 when the device is revoked', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1', userId: 'u1', deviceId: 'd1' });

    await expect(controller.getDeviceKeyPackage('u1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException
    );
    // The revocation short-circuits: the key package table is never consulted.
    expect(keyPackageRepo.findOne).not.toHaveBeenCalled();
  });

  it('answers 404 when metadata is set on a device that is not there', async () => {
    await expect(
      controller.updateDeviceMetadata('u1', 'd1', { deviceName: 'Mi 9T' }, 'u1', undefined)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(keyPackageRepo.save).not.toHaveBeenCalled();
  });

  /**
   * The control. An empty metadata body IS the caller's fault, and it must keep its 400 - otherwise
   * the swap above would have traded one wrong status for another.
   */
  it('keeps 400 for a metadata request with no field to write', async () => {
    await expect(
      controller.updateDeviceMetadata('u1', 'd1', {}, 'u1', undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
    // It refuses on the body alone, before it ever looks for the row.
    expect(keyPackageRepo.findOne).not.toHaveBeenCalled();
  });
});
