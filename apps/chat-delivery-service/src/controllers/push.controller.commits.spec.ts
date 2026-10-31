/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { externalCommitFrame } from '../testing/mlsFrameFixture';

describe('PushController - getCommitsPush (PushSecret commit catch-up)', () => {
  let controller: PushController;

  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
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
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
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
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412',
    });
    getCommitsSince.mockResolvedValue(canned);

    const res = await controller.getCommitsPush('PushSecret sekret', body);

    expect(res).toBe(canned);
    expect(getCommitsSince).toHaveBeenCalledWith('g1', 3, 'u1');
  });

  it('rejects a wrong PushSecret and never reads the commit log', async () => {
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412',
    });

    await expect(controller.getCommitsPush('PushSecret wrong-one', body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(getCommitsSince).not.toHaveBeenCalled();
  });

  it('rejects a missing PushSecret header', async () => {
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412',
    });

    await expect(controller.getCommitsPush('', body)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getCommitsSince).not.toHaveBeenCalled();
  });
});

describe('PushController - sendMessagePush', () => {
  const sendMessage = jest.fn();

  /** The controller with a push secret that verifies and a delivery answering `sendMessage`. */
  const pushController = async () => {
    sendMessage.mockReset().mockResolvedValue({
      status: 'processed',
      queued: 2,
      sent: 1,
      receivedAt: 1_700_000_000_123,
    });
    const pushTokenRepo = {
      findOne: jest.fn().mockResolvedValue({
        pushSecret: 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412',
      }),
      update: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: { sendMessage } },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    return module.get(PushController);
  };

  it('hands back the receivedAt every recipient copy is dated by, as the foreground route does', async () => {
    const controller = await pushController();

    const res = await controller.sendMessagePush('PushSecret sekret', {
      userId: 'u1',
      deviceId: 'd1',
      groupId: 'g1',
      proto: 'AAA=',
    });

    expect(res).toEqual({ status: 'sent', queued: 2, sent: 1, receivedAt: 1_700_000_000_123 });
  });

  it('relays only private (application) frames: a public handshake frame is refused, typed and logged', async () => {
    const controller = await pushController();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const refusal = await controller
        .sendMessagePush('PushSecret sekret', {
          userId: 'u1',
          deviceId: 'd1',
          groupId: 'g1',
          proto: externalCommitFrame('g1', 5n, 'u1:d1'),
        })
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toEqual({
        error: 'public_frame_refused',
        message: 'this send is not accepted',
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('REJECT public_frame_refused'));
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

// The `sinceEpoch` cases that used to live here asserted the clamp - a negative or non-numeric
// epoch becoming 0 - which was the half of this route that disagreed with its JWT twin. Both routes
// now share one policy, and it is asserted over BOTH of them in `commitReplay.onePolicy.spec.ts`.
// This file keeps what is only true of this route: the PushSecret.
