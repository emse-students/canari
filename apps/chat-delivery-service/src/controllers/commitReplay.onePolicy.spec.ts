/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * COMMIT REPLAY IS SERVED TWICE, AND THE TWO ROUTES DISAGREED ABOUT WHAT AN EPOCH IS.
 *
 * `GET mls/commits/:groupId` is for a JWT-bearing client; `POST mls/push/commits` is its PushSecret
 * twin for the background push path, which cannot mint a JWT. They call the SAME `getCommitsSince`,
 * so a caller's epoch means one thing - and it did not:
 *
 * | input | the JWT route | the PushSecret route |
 * | --- | --- | --- |
 * | `-5` | 400 | replay from **0** |
 * | `NaN` / a word | 400 | replay from **0** |
 * | `'5abc'` | **5** (`parseInt` stops at the letter) | n/a |
 * | `3.9` | **3** | **3** |
 *
 * The silent zero is the one that bites, and it is a FALLBACK: "I could not tell you where I am" is
 * not "I am at epoch 0". It hands back the whole log to a device that cannot use it - one that
 * cannot read its own epoch has no state to apply those commits to - and every caller in this
 * repository already refuses to ask, the Android service and both iOS paths checking `epoch >= 0`
 * before the request.
 *
 * **This file drives BOTH routes over ONE table**, because that is the only assertion that survives
 * a future edit to either: a fusion asserted only on the shared helper is a fusion a new caller can
 * walk past by parsing its own input first.
 */
const SECRET = 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412';

/**
 * The two tables are separate so that every `expect` is unconditional. An assertion reached through
 * an `if` is one the runner cannot tell from a branch that never ran, which is the whole failure
 * mode a policy table is supposed to close.
 */
const ACCEPTED: { name: string; query: string; body: number; epoch: number }[] = [
  { name: 'a positive epoch', query: '3', body: 3, epoch: 3 },
  { name: 'epoch zero, which is a real request', query: '0', body: 0, epoch: 0 },
];

const REFUSED: { name: string; query: string | undefined; body: unknown }[] = [
  { name: 'a negative epoch', query: '-5', body: -5 },
  { name: 'a fractional epoch', query: '3.9', body: 3.9 },
  { name: 'NaN', query: 'NaN', body: NaN },
  { name: 'a number with a tail', query: '5abc', body: '5abc' },
  { name: 'an absent epoch', query: undefined, body: undefined },
  { name: 'an empty epoch', query: '', body: '' },
  { name: 'null', query: 'null', body: null },
];

describe('commit replay - one sinceEpoch policy, both routes', () => {
  let messaging: MessagingController;
  let push: PushController;

  const getCommitsSince = jest.fn();
  const messagingService = { getCommitsSince } as unknown as MessagingService;
  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  /** The PushSecret route's body, with only the epoch varying. */
  const pushBody = (sinceEpoch: unknown) => ({
    userId: 'u1',
    deviceId: 'd1',
    groupId: 'g1',
    sinceEpoch: sinceEpoch as number,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController, PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    messaging = module.get(MessagingController);
    push = module.get(PushController);
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: SECRET });
    getCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 9, belowFloor: false });
  });

  describe.each(ACCEPTED)('$name', ({ query, body, epoch }) => {
    it('the JWT route passes it through unchanged', async () => {
      await messaging.getCommitsSince('u1', 'g1', query);

      expect(getCommitsSince).toHaveBeenCalledWith('g1', epoch, 'u1');
    });

    it('the PushSecret route passes it through unchanged', async () => {
      await push.getCommitsPush('PushSecret sekret', pushBody(body));

      expect(getCommitsSince).toHaveBeenCalledWith('g1', epoch, 'u1');
    });
  });

  describe.each(REFUSED)('$name', ({ query, body }) => {
    it('the JWT route refuses it, and never reads the commit log', async () => {
      await expect(messaging.getCommitsSince('u1', 'g1', query)).rejects.toBeInstanceOf(
        BadRequestException
      );

      expect(getCommitsSince).not.toHaveBeenCalled();
    });

    it('the PushSecret route refuses it, and never reads the commit log', async () => {
      await expect(push.getCommitsPush('PushSecret sekret', pushBody(body))).rejects.toBeInstanceOf(
        BadRequestException
      );

      expect(getCommitsSince).not.toHaveBeenCalled();
    });
  });

  it('is driving both routes, and not one of them twice', async () => {
    // The self-check: if both handles resolved to one controller, every row above would be a
    // statement about a single route and the divergence this file exists for would be invisible.
    expect(messaging).toBeInstanceOf(MessagingController);
    expect(push).toBeInstanceOf(PushController);

    await messaging.getCommitsSince('u1', 'g1', '7');
    await push.getCommitsPush('PushSecret sekret', pushBody(7));

    expect(getCommitsSince).toHaveBeenCalledTimes(2);
  });
});
