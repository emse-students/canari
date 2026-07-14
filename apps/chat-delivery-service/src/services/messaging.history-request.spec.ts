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
import { ApnsService } from './apns.service';

describe('MessagingService - notifyHistoryRequest', () => {
  let service: MessagingService;

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  };
  const deviceGroupRepo = { find: jest.fn().mockResolvedValue([]) };

  const emptyRepo = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  });

  const body = {
    groupId: 'g1',
    requesterUserId: 'reqU',
    requesterDeviceId: 'reqD',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: emptyRepo(),
        },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: deviceGroupRepo,
        },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: ApnsService, useValue: {} },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  it('forwards to an online member and reports it as the target', async () => {
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest(body);

    expect(res).toEqual({ status: 'forwarded', target: 'ua:da' });
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('returns no_peer_online and publishes nothing when no member is online', async () => {
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db']);
    redis.exists.mockResolvedValue(0);

    const res = await service.notifyHistoryRequest(body);

    expect(res).toEqual({ status: 'no_peer_online' });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('never forwards the request back to the requester device', async () => {
    redis.smembers.mockResolvedValue(['reqU:reqD']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest(body);

    expect(res).toEqual({ status: 'no_peer_online' });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('randomizes the responder so retries rotate past a frozen-online peer', async () => {
    // Members come back in a stable order; without randomization the first (ua:da) would always be
    // picked. Forcing Math.random=0 makes the Fisher-Yates shuffle rotate a different member to the
    // front, proving the choice is no longer positionally fixed.
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db', 'uc:dc']);
    redis.exists.mockResolvedValue(1);
    const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

    const res = await service.notifyHistoryRequest(body);

    expect(res.status).toBe('forwarded');
    expect(res.target).not.toBe('ua:da');
    randSpy.mockRestore();
  });
});
