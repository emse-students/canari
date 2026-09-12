/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * THIS ROUTE HAD NO TEST, WHICH IS HOW IT SPENT A MONTH RETURNING 400 BEFORE THE WELCOME.
 *
 * `push.controller.commits.spec.ts` covers `mls/push/commits`, a different endpoint on the same
 * controller, and its existence was mistaken for coverage of the background re-add. The assertion
 * that matters here is the first one: the commit reaches `validateCommit` as `proto`. Every other
 * case exists so that a future change cannot restore the broadcast-without-validation branch that
 * was deleted with this fix.
 */
describe('PushController - sendWelcomeAndCommitPush (background re-add)', () => {
  let controller: PushController;

  // sha256('sekret') - the stored secret is the hash, the header carries the plaintext.
  const STORED_SECRET = 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412';
  const AUTH = 'PushSecret sekret';

  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
  const groupMemberRepo = { findOne: jest.fn() };
  const validateCommit = jest.fn();
  const sendWelcome = jest.fn();
  const sendMessage = jest.fn();
  const messagingService = {
    validateCommit,
    sendWelcome,
    sendMessage,
  } as unknown as MessagingService;

  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  const body = {
    userId: 'u1',
    deviceId: 'd1',
    groupId: 'g1',
    targetUserId: 'u2',
    targetDeviceId: 'd2',
    welcomePayload: 'V0VMQ09NRQ==',
    ratchetTreePayload: 'VFJFRQ==',
    commitPayload: 'Q09NTUlU',
    baseEpoch: 7,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: STORED_SECRET });
    groupMemberRepo.findOne.mockResolvedValue({ groupId: 'g1', userId: 'u2' });
    validateCommit.mockResolvedValue({ accepted: true, newEpoch: 8, currentEpoch: 7 });
    sendWelcome.mockResolvedValue(undefined);
    sendMessage.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  it('hands the commit to validateCommit as `proto`, then sends the Welcome and broadcasts', async () => {
    const res = await controller.sendWelcomeAndCommitPush(AUTH, body);

    // THE REGRESSION THIS FILE EXISTS FOR: without `proto`, validateCommit throws a 400 and the
    // Welcome below never happens. Asserted by value, not by presence - the proto must be the very
    // commit that gets broadcast, or the commit log records something nobody replayed.
    expect(validateCommit).toHaveBeenCalledWith({
      groupId: 'g1',
      deviceId: 'd1',
      baseEpoch: 7,
      proto: 'Q09NTUlU',
    });
    expect(sendWelcome).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ proto: 'Q09NTUlU', groupId: 'g1', isCommit: true })
    );
    expect(res).toEqual({ status: 'done' });
  });

  it('broadcasts the SAME bytes it asked the commit log to record', async () => {
    await controller.sendWelcomeAndCommitPush(AUTH, body);

    const recorded = validateCommit.mock.calls[0][0].proto;
    const broadcast = sendMessage.mock.calls[0][0].proto;
    expect(recorded).toBe(broadcast);
  });

  it('refuses a body with no baseEpoch, and neither validates nor sends anything', async () => {
    // The deleted branch used to treat this as "broadcast without validating", which advanced the
    // real MLS epoch while the commit log gained no row - a hole no later call can refill.
    const legacy = { ...body } as Partial<typeof body>;
    delete legacy.baseEpoch;

    await expect(
      controller.sendWelcomeAndCommitPush(AUTH, legacy as typeof body)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(validateCommit).not.toHaveBeenCalled();
    expect(sendWelcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a non-finite baseEpoch the same way', async () => {
    await expect(
      controller.sendWelcomeAndCommitPush(AUTH, { ...body, baseEpoch: Number.NaN })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(validateCommit).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends neither Welcome nor broadcast when the commit is rejected', async () => {
    validateCommit.mockResolvedValue({
      accepted: false,
      reason: 'epoch_mismatch',
      currentEpoch: 9,
    });

    const res = await controller.sendWelcomeAndCommitPush(AUTH, body);

    expect(res).toEqual({ status: 'rejected', reason: 'epoch_mismatch', currentEpoch: 9 });
    expect(sendWelcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a target who is not a member, before validating anything', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);

    const res = await controller.sendWelcomeAndCommitPush(AUTH, body);

    expect(res).toEqual({ status: 'rejected', reason: 'not_a_member' });
    expect(validateCommit).not.toHaveBeenCalled();
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it('refuses a wrong PushSecret and reaches nothing', async () => {
    await expect(
      controller.sendWelcomeAndCommitPush('PushSecret wrong-one', body)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(validateCommit).not.toHaveBeenCalled();
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it('refuses an empty commitPayload rather than validating an empty proto', async () => {
    await expect(
      controller.sendWelcomeAndCommitPush(AUTH, { ...body, commitPayload: '' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(validateCommit).not.toHaveBeenCalled();
  });
});
