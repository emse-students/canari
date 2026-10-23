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

/**
 * A DEVICE THAT IS DELETED, REVOKED OR COLLECTED LEAVES EVERY GROUP WITH ITS QUEUE, IN ONE
 * TRANSACTION (`endDeviceMemberships`): its device rows and everything queued for it - Welcomes
 * included - go together, so no Welcome outlives the membership it was for.
 */
describe('MessagingService - purgeDeviceFootprint', () => {
  let service: MessagingService;
  let txDeletes: Array<{ entity: unknown; where: unknown }>;
  const transaction = jest.fn();
  const repo = () => ({
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  });
  let deviceGroupRepo: ReturnType<typeof repo> & { manager: { transaction: jest.Mock } };
  let queuedRepo: ReturnType<typeof repo>;
  const redis = { srem: jest.fn().mockResolvedValue(1) };

  beforeEach(async () => {
    jest.clearAllMocks();
    txDeletes = [];
    transaction.mockImplementation((cb: (m: unknown) => Promise<unknown>) =>
      cb({
        getRepository: (entity: unknown) => ({
          delete: (where: unknown) => {
            txDeletes.push({ entity, where });
            return Promise.resolve({ affected: entity === QueuedMessage ? 4 : 2 });
          },
        }),
      })
    );
    deviceGroupRepo = { ...repo(), manager: { transaction } };
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
});
