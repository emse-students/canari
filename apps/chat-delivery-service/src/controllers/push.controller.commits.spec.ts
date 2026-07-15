/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

describe('PushController - getCommitsPush (PushSecret commit catch-up)', () => {
  let controller: PushController;

  const pushTokenRepo = { findOne: jest.fn() };
  const getCommitsSince = jest.fn();
  const messagingService = { getCommitsSince } as unknown as MessagingService;

  const emptyRepo = () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messagingService },
      ],
    })
      // The controller declares ThrottlerGuard/HeaderAuthGuard on OTHER routes; stub them so the
      // test module compiles (this endpoint is PushSecret-authed, not guarded).
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  const body = { userId: 'u1', deviceId: 'd1', groupId: 'g1', sinceEpoch: 3 };
  const canned = {
    commits: [{ baseEpoch: 3, proto: 'AAA=' }],
    activeEpoch: 4,
    belowFloor: false,
  };

  it('returns the ordered commits for a valid PushSecret', async () => {
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: 'sekret' });
    getCommitsSince.mockResolvedValue(canned);

    const res = await controller.getCommitsPush('PushSecret sekret', body);

    expect(res).toBe(canned);
    expect(getCommitsSince).toHaveBeenCalledWith('g1', 3, 'u1');
  });

  it('rejects a wrong PushSecret and never reads the commit log', async () => {
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: 'sekret' });

    await expect(controller.getCommitsPush('PushSecret wrong-one', body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(getCommitsSince).not.toHaveBeenCalled();
  });

  it('rejects a missing PushSecret header', async () => {
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: 'sekret' });

    await expect(controller.getCommitsPush('', body)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getCommitsSince).not.toHaveBeenCalled();
  });

  it('clamps a negative or non-numeric sinceEpoch to 0', async () => {
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: 'sekret' });
    getCommitsSince.mockResolvedValue(canned);

    await controller.getCommitsPush('PushSecret sekret', {
      ...body,
      sinceEpoch: -5,
    });
    expect(getCommitsSince).toHaveBeenLastCalledWith('g1', 0, 'u1');

    await controller.getCommitsPush('PushSecret sekret', {
      ...body,
      sinceEpoch: NaN,
    });
    expect(getCommitsSince).toHaveBeenLastCalledWith('g1', 0, 'u1');
  });
});
