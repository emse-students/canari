/// <reference types="jest" />

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * The two instants a device dates a derived line by: when a commit was accepted
 * (`GET mls/commits/:groupId/accepted-at`) and when the requester's own seat was removed
 * (`GET mls/groups/:groupId/own-removal`). Both refuse an unauthenticated request AS SUCH, before
 * reading anything it asked, and hand the requesting device on to the service.
 */
describe('MessagingController - the commit and removal instants', () => {
  let controller: MessagingController;
  const getCommitAcceptedAt = jest.fn();
  const getOwnRemovalAt = jest.fn();

  beforeEach(async () => {
    getCommitAcceptedAt.mockReset().mockResolvedValue({ acceptedAt: null });
    getOwnRemovalAt.mockReset().mockResolvedValue({ removedAt: null });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        {
          provide: MessagingService,
          useValue: { getCommitAcceptedAt, getOwnRemovalAt } as unknown as MessagingService,
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  it('accepted-at: a missing x-user-id is refused as such, even with a bad epoch', async () => {
    await expect(
      controller.getCommitAcceptedAt(undefined, 'dev-1', 'g1', 'not-a-number')
    ).rejects.toThrow('missing x-user-id');
    expect(getCommitAcceptedAt).not.toHaveBeenCalled();
  });

  it('accepted-at: a bad epoch is a 400', async () => {
    await expect(
      controller.getCommitAcceptedAt('alice', 'dev-1', 'g1', '-3')
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepted-at: passes the epoch, the user and the device to the service', async () => {
    await controller.getCommitAcceptedAt('alice', 'dev-1', 'g1', '4');
    expect(getCommitAcceptedAt).toHaveBeenCalledWith('g1', 4, 'alice', 'dev-1');
  });

  it('own-removal: refuses a missing x-user-id and passes the device on', async () => {
    await expect(controller.getOwnRemovalAt(undefined, 'dev-1', 'g1')).rejects.toThrow(
      'missing x-user-id'
    );
    await controller.getOwnRemovalAt('alice', 'dev-1', 'g1');
    expect(getOwnRemovalAt).toHaveBeenCalledWith('g1', 'alice', 'dev-1');
  });
});
