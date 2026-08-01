/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
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
 * Deleting a device denylists its id permanently, and the client deliberately restores the SAME id
 * after a reinstall. Accepting that re-registration wrote a key package, answered 200, and left the
 * device filtered out of getUserDevices and resolving to a null key package for good: registered,
 * invisible, never invitable, with no error raised anywhere. The refusal is what the client turns
 * into a re-enrolment under a fresh id.
 */
describe('DevicesController.registerDevice - revoked device', () => {
  let controller: DevicesController;
  let revokedDeviceRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let keyPackageRepo: { findOne: jest.Mock; count: jest.Mock; save: jest.Mock; create: jest.Mock };

  const BODY = {
    userId: 'u1',
    deviceId: 'd1',
    keyPackage: 'a2V5',
  };

  beforeEach(async () => {
    revokedDeviceRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
      create: jest.fn(),
    };
    keyPackageRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockResolvedValue({}),
      create: jest.fn((v) => v),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
  });

  it('refuses a revoked device id, and writes nothing', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1', userId: 'u1', deviceId: 'd1' });

    await expect(controller.registerDevice(BODY, 'u1', undefined)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    // The client branches on this code, never on the message.
    await expect(controller.registerDevice(BODY, 'u1', undefined)).rejects.toMatchObject({
      response: { code: 'DEVICE_REVOKED' },
    });
    expect(keyPackageRepo.save).not.toHaveBeenCalled();
  });

  it('lets an ordinary device through', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);

    await controller.registerDevice(BODY, 'u1', undefined);

    expect(keyPackageRepo.save).toHaveBeenCalled();
  });
});
