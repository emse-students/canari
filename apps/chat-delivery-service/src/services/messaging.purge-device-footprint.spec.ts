/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';

/**
 * A DEVICE THAT IS DELETED, REVOKED OR COLLECTED LEAVES EVERY GROUP WITH ITS QUEUE, IN ONE
 * TRANSACTION (`endDeviceMemberships`): its device rows and everything queued for it - Welcomes
 * included - go together, so no Welcome outlives the membership it was for.
 */
describe('MessagingService - purgeDeviceFootprint', () => {
  let service: MessagingService;
  let txDeletes: Array<{ entity: unknown; where: unknown }>;
  /** Every statement the transaction ran, in order: a recording INSERT, then the deletes. */
  let txSteps: string[];
  const managerDelete = jest.fn();
  const transaction = jest.fn();
  const repo = () => ({
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  });
  let deviceGroupRepo: ReturnType<typeof repo> & {
    manager: { transaction: jest.Mock; delete: jest.Mock };
  };
  let queuedRepo: ReturnType<typeof repo>;
  const redis = { srem: jest.fn().mockResolvedValue(1) };

  beforeEach(async () => {
    jest.clearAllMocks();
    txDeletes = [];
    txSteps = [];
    managerDelete.mockResolvedValue({ affected: 1 });
    transaction.mockImplementation((cb: (m: unknown) => Promise<unknown>) =>
      cb({
        query: (sql: string) => {
          txSteps.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
          // The two key groups of the device's three groups.
          return Promise.resolve([{ groupId: 'kg-1' }, { groupId: 'kg-2' }]);
        },
        getRepository: (entity: unknown) => ({
          delete: (where: unknown) => {
            txDeletes.push({ entity, where });
            txSteps.push(`DELETE ${(entity as { name: string }).name}`);
            return Promise.resolve({ affected: entity === QueuedMessage ? 4 : 2 });
          },
        }),
      })
    );
    deviceGroupRepo = { ...repo(), manager: { transaction, delete: managerDelete } };
    deviceGroupRepo.find.mockResolvedValue([{ groupId: 'g-1' }, { groupId: 'g-2' }]);
    queuedRepo = repo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: repo() },
        { provide: getRepositoryToken(Group), useValue: repo() },
        { provide: getRepositoryToken(KeyPackage), useValue: repo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: repo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: repo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: repo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: repo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: repo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  it('deletes the device rows and the whole queue of that device in one transaction', async () => {
    const purged = await service.purgeDeviceFootprint('bob', 'b1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txDeletes).toEqual([
      { entity: QueuedMessage, where: { recipientId: 'bob', deviceId: 'b1' } },
      { entity: DeviceGroupMembership, where: { userId: 'bob', deviceId: 'b1' } },
    ]);
    // Never outside it, where a failure in between would leave one without the other.
    expect(deviceGroupRepo.delete).not.toHaveBeenCalled();
    expect(queuedRepo.delete).not.toHaveBeenCalled();
    expect(purged).toMatchObject({ groupsCleaned: 2, queuedMessagesDeleted: 4 });
    expect(redis.srem).toHaveBeenCalledWith('group:members:g-1', 'bob:b1');
    expect(redis.srem).toHaveBeenCalledWith('group:members:g-2', 'bob:b1');
  });

  it('a revocation records the key groups the device held, in the SAME transaction, before its rows go', async () => {
    const purged = await service.purgeDeviceFootprint('bob', 'b1', { recordKeyGroupsHeld: true });

    expect(transaction).toHaveBeenCalledTimes(1);
    // Read from the rows the transaction then deletes - a crash in between cannot lose the binding.
    expect(txSteps).toEqual([
      'INSERT INTO dm_revoked_device_groups',
      'DELETE QueuedMessage',
      'DELETE DeviceGroupMembership',
    ]);
    expect(purged.keyGroupsRecorded).toBe(2);
  });

  it('the stale-device GC and the PIN reset record nothing: they do not revoke', async () => {
    const purged = await service.purgeDeviceFootprint('bob', 'b1');

    expect(txSteps).toEqual(['DELETE QueuedMessage', 'DELETE DeviceGroupMembership']);
    expect(purged.keyGroupsRecorded).toBe(0);
  });

  /** A binding ends on STATE: the accepted commit that declares the Remove of that device. */
  describe('endRevokedDeviceBindings', () => {
    const end = (removes: unknown) =>
      (
        service as unknown as {
          endRevokedDeviceBindings: (g: string, r: unknown, t: string) => Promise<void>;
        }
      ).endRevokedDeviceBindings('kg-1', removes, 'trace');

    it('ends the one device named with its person, and every device of a person named alone', async () => {
      await end([{ userId: 'bob', deviceId: 'b1' }, { userId: 'carol' }]);

      expect(managerDelete).toHaveBeenCalledWith(RevokedDeviceGroup, {
        groupId: 'kg-1',
        userId: 'bob',
        deviceId: 'b1',
      });
      expect(managerDelete).toHaveBeenCalledWith(RevokedDeviceGroup, {
        groupId: 'kg-1',
        userId: 'carol',
      });
    });

    it('touches nothing for a commit that declares nothing', async () => {
      await end(undefined);
      await end([{ deviceId: 'b1' }]);

      expect(managerDelete).not.toHaveBeenCalled();
    });

    it('logs a failure and never throws: the commit is already accepted', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      managerDelete.mockRejectedValue(new Error('db down'));

      await expect(end([{ userId: 'bob', deviceId: 'b1' }])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT ended'));
    });
  });
});
