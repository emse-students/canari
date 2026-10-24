/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  it('hands the commit to validateCommit as `proto`, WITH the Welcome it stores in the advance', async () => {
    const res = await controller.sendWelcomeAndCommitPush(AUTH, body);

    // THE REGRESSION THIS FILE EXISTS FOR: without `proto`, validateCommit throws a 400 and the
    // Welcome below never happens. Asserted by value, not by presence - the proto is the very
    // commit the gate records AND fans out, so the log holds what every member replays.
    // The committer is the device the PushSecret authenticated, held to the foreground gate.
    expect(validateCommit).toHaveBeenCalledWith(
      {
        groupId: 'g1',
        deviceId: 'd1',
        senderId: 'u1',
        baseEpoch: 7,
        proto: 'Q09NTUlU',
        // The re-added device is recorded with the advance, before its Welcome.
        admits: [{ userId: 'u2', deviceId: 'd2' }],
        // AND ITS WELCOME, stored in the transaction that moves the epoch: an accepted commit
        // always has its Welcome, so there is no second call left to fail after the advance.
        welcome: { userId: 'u2', deviceId: 'd2', payload: 'V0VMQ09NRQ==', ratchetTree: 'VFJFRQ==' },
      },
      'u1'
    );
    expect(sendWelcome).not.toHaveBeenCalled();
    // A TYPED ANSWER: the phone installs its staged state on `accepted` and on nothing else.
    expect(res).toEqual({ status: 'accepted', newEpoch: 8 });
  });

  it('publishes the base of the epoch the commit creates WITH the commit, as the foreground does', async () => {
    // COMM-22: the committer is the only device that can export the external-join base for the
    // epoch it creates. Without it the published base stays one epoch behind, and every external
    // join is refused as stale until a member republishes it.
    await controller.sendWelcomeAndCommitPush(AUTH, { ...body, groupInfo: 'R0lORk8=' });

    expect(validateCommit).toHaveBeenCalledWith(
      expect.objectContaining({ proto: 'Q09NTUlU', baseEpoch: 7, groupInfo: 'R0lORk8=' }),
      'u1'
    );
  });

  it('answers a Welcome target the gate refuses with 409 and its typed reason, sending nothing', async () => {
    // Decided BEFORE the epoch moves now, so it is a refusal like any other: the phone discards
    // what it staged and the group never holds a newcomer without a Welcome.
    validateCommit.mockResolvedValue({
      accepted: false,
      reason: 'welcome_target_not_member',
      currentEpoch: 7,
    });

    const refusal = await refusalOf(controller.sendWelcomeAndCommitPush(AUTH, body));

    expect(refusal).toEqual({
      status: 409,
      body: { status: 'rejected', reason: 'welcome_target_not_member', currentEpoch: 7 },
    });
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it('leaves the fan-out to the gate, so every member receives the commit ONCE', async () => {
    // `validateCommit` fans the accepted commit out itself, under its lock. The route broadcast it
    // a second time, so every member received the same commit twice.
    await controller.sendWelcomeAndCommitPush(AUTH, body);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends neither Welcome nor broadcast when the gate refuses the committer', async () => {
    validateCommit.mockRejectedValue(
      new ForbiddenException({
        error: 'committer_not_member',
        message: 'this commit is not accepted',
      })
    );

    await expect(controller.sendWelcomeAndCommitPush(AUTH, body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(sendWelcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
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

  /** The refusal the route throws, read the way the phone reads it: a status and a body. */
  async function refusalOf(call: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    const thrown = await call.then(
      () => {
        throw new Error('expected a refusal, got an answer');
      },
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(ConflictException);
    const e = thrown as ConflictException;
    return { status: e.getStatus(), body: e.getResponse() };
  }

  it('answers a stale base with 409 and a typed epoch_mismatch, sending nothing', async () => {
    // THE DEFECT: this answered HTTP 201, and the phone, which reads the status code, logged
    // "Welcome sent" for a Welcome that was never sent.
    validateCommit.mockResolvedValue({
      accepted: false,
      reason: 'epoch_mismatch',
      currentEpoch: 9,
    });

    const refusal = await refusalOf(controller.sendWelcomeAndCommitPush(AUTH, body));

    expect(refusal).toEqual({
      status: 409,
      body: { status: 'rejected', reason: 'epoch_mismatch', currentEpoch: 9 },
    });
    expect(sendWelcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('answers a commit racing another with 409 and a typed concurrent_commit', async () => {
    validateCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 7,
    });

    const refusal = await refusalOf(controller.sendWelcomeAndCommitPush(AUTH, body));

    expect(refusal).toEqual({
      status: 409,
      body: { status: 'rejected', reason: 'concurrent_commit', currentEpoch: 7 },
    });
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it('answers a target who is not a member with 409 and a typed not_a_member, validating nothing', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);

    const refusal = await refusalOf(controller.sendWelcomeAndCommitPush(AUTH, body));

    expect(refusal).toEqual({ status: 409, body: { status: 'rejected', reason: 'not_a_member' } });
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
