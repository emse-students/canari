/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, FindOperator, Not } from 'typeorm';
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
import { DeviceSignatureKeysService } from '../services/device-signature-keys.service';
import { MAX_DEVICES_PER_USER } from '../retention.constants';

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
  let keyPackageRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /** The one statement that writes the key package row (`upsertDeviceKeyPackage`). */
  let query: jest.Mock;
  const upserted = () =>
    query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO key_package'));
  /** The number `countLiveDevices` reads back, set per test. */
  let liveDevices: number;
  let recordKeys: jest.Mock;

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
    liveDevices = 0;
    recordKeys = jest.fn().mockResolvedValue(undefined);
    // `countLiveDevices` asks the database the whole question in one statement, so the seam a test
    // can hold is the builder - what it ASKS is asserted in devices.controller.live-cap.spec.ts.
    const qb = {
      select: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      getRawOne: jest.fn(() => Promise.resolve({ n: String(liveDevices) })),
    };
    keyPackageRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qb),
    };
    query = jest.fn().mockResolvedValue([{ inserted: true }]);

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
        { provide: DataSource, useValue: { query } },
        { provide: MessagingService, useValue: {} },
        { provide: DeviceSignatureKeysService, useValue: { record: recordKeys } },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
  });

  it('refuses a revoked device id, and writes nothing', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      deviceId: 'd1',
      reason: 'retired',
    });

    await expect(controller.registerDevice(BODY, 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    // The client branches on this code, never on the message.
    await expect(controller.registerDevice(BODY, 'u1')).rejects.toMatchObject({
      response: { code: 'DEVICE_REVOKED', reason: 'retired' },
    });
    expect(upserted()).toHaveLength(0);
  });

  it('lets an ordinary device through', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);

    await controller.registerDevice(BODY, 'u1');

    expect(upserted()).toHaveLength(1);
  });

  /**
   * Production 2026-11-07 (`1.6.6`): two registrations of one device in the same millisecond both
   * read "no row" and the second INSERT answered 500 on `UNIQUE ("userId", "deviceId")`. The row is
   * now written by ONE `INSERT ... ON CONFLICT DO UPDATE`, with no read of the pair before it; the
   * overlap itself is proven against PostgreSQL in device-key-package.integration.spec.ts.
   */
  it('writes the key package row in ONE statement, never a read of the pair then a write', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);

    await controller.registerDevice(
      { ...BODY, notAfter: '2027-01-01T00:00:00.000Z', deviceOs: 'android' },
      'u1'
    );

    expect(upserted()).toHaveLength(1);
    const [sql, params] = upserted()[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT ("userId", "deviceId") DO UPDATE');
    expect(params.slice(1, 8)).toEqual([
      'u1',
      'd1',
      'a2V5',
      new Date('2027-01-01T00:00:00.000Z'),
      null,
      'android',
      null,
    ]);
    // The only read of `key_package` left is the cross-account one, which excludes the caller.
    for (const [arg] of keyPackageRepo.findOne.mock.calls) {
      expect((arg as { where: { userId: unknown } }).where.userId).toEqual(Not('u1'));
    }
  });

  it('refuses a device id another account holds, and writes nothing', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    // Answers by the `where`: the other account's row matches only a lookup that EXCLUDES the caller.
    const rows = [{ id: 'kp-u2', userId: 'u2', deviceId: 'd1' }];
    keyPackageRepo.findOne.mockImplementation(
      async ({ where }: { where: { deviceId: string; userId: unknown } }) =>
        rows.find(
          (r) =>
            r.deviceId === where.deviceId &&
            (where.userId instanceof FindOperator
              ? where.userId.type === 'not' && r.userId !== where.userId.value
              : r.userId === where.userId)
        ) ?? null
    );

    await expect(controller.registerDevice(BODY, 'u1')).rejects.toMatchObject({
      status: 409,
      response: { error: 'device_id_taken' },
    });
    expect(keyPackageRepo.findOne).toHaveBeenCalledWith({
      where: { deviceId: 'd1', userId: Not('u1') },
      select: { id: true },
    });
    expect(recordKeys).not.toHaveBeenCalled();
    expect(upserted()).toHaveLength(0);

    // The owner itself re-registers the same id as before.
    await controller.registerDevice({ ...BODY, userId: 'u2' }, 'u2');
    expect(recordKeys).toHaveBeenCalledWith('u2', 'd1', ['a2V5'], 'register-device');
  });

  it('records the device signature key BEFORE storing the package, so a failure is retried', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    recordKeys.mockRejectedValue(new Error('db down'));

    await expect(controller.registerDevice(BODY, 'u1')).rejects.toThrow('db down');

    expect(recordKeys).toHaveBeenCalledWith('u1', 'd1', ['a2V5'], 'register-device');
    expect(upserted()).toHaveLength(0);
  });

  /**
   * The per-user cap is TERMINAL: unlike a 5xx or any other 400 here, no retry can lift it - the
   * account has to lose a device first. It used to throw a bare sentence and log nothing at all,
   * firing before the START line, so a full account produced a 400 with no server trace while the
   * client logged "deferred to next connection" on every reconnection and healed never. The code is
   * what lets the client tell terminal from retryable without reading prose.
   */
  it('refuses a device over the cap with a code the client can classify, and says so in the log', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    liveDevices = MAX_DEVICES_PER_USER;
    const warn = jest
      .spyOn((controller as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(controller.registerDevice(BODY, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.registerDevice(BODY, 'u1')).rejects.toMatchObject({
      response: { code: 'DEVICE_LIMIT_REACHED', max: MAX_DEVICES_PER_USER },
    });
    expect(upserted()).toHaveLength(0);
    // A refusal with no trace is found by hand, a day late: the line must carry the count it read.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      `live=${MAX_DEVICES_PER_USER}/${MAX_DEVICES_PER_USER}`
    );
  });
});
