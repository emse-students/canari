/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { AppController } from './app.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import { PushToken } from './entities/push-token.entity';
import { MlsGroupInfo } from './entities/mls-group-info.entity';
import { MessagingService } from './services/messaging.service';

/**
 * `reportStaleExternalJoinBases` is the platform's only witness that a conversation has become
 * unenterable by any device that does not already hold its tree.
 *
 * The commit gate accepts a published base whose epoch EQUALS the group's active epoch and nothing
 * else, and only a member holding the tree can mint one. Two mechanisms already keep that from
 * happening - a commit has carried its own base since 2026-08-26, and a holder repairs a base it
 * finds behind on every connection since v0.16.4 - and neither is a witness. Production on
 * 2026-09-12 still held three conversations one epoch behind since 2026-08-29, 08-30 and 08-31, and
 * the only thing that ever found them was somebody writing the join by hand. Twice: the same
 * population was counted the same way on 2026-09-04.
 *
 * WHAT IS PINNED HERE IS THE PARTITION, not the SQL - a mocked repository never parses a query, so
 * the builder's output is only ever verified against a real Postgres. What a mock CAN prove is that
 * a group still holding an ACTIVE device membership is reported as waiting for that member, while
 * one holding none is reported as permanently shut. The two send their reader to opposite places
 * and the rows cannot tell them apart on their own.
 */
describe('AppController - reportStaleExternalJoinBases', () => {
  let controller: AppController;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  const staleBuilder = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const groupInfoRepo = { createQueryBuilder: jest.fn(() => staleBuilder) };
  const deviceGroupRepo = { find: jest.fn(), delete: jest.fn(), createQueryBuilder: jest.fn() };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  const DAY = 24 * 60 * 60 * 1000;
  /** A published base one epoch behind, last written `daysAgo` days ago - the measured shape. */
  const behind = (groupId: string, daysAgo: number, baseEpoch = 283) => ({
    groupId,
    baseEpoch,
    activeEpoch: baseEpoch + 1,
    baseUpdatedAt: new Date(Date.now() - daysAgo * DAY),
  });
  const membership = (groupId: string, status: 'active' | 'pending') => ({ groupId, status });

  /** Invoke the private cron body the same way the scheduler does. */
  const run = () =>
    (
      controller as unknown as { reportStaleExternalJoinBases(): Promise<void> }
    ).reportStaleExternalJoinBases();

  beforeEach(async () => {
    jest.clearAllMocks();
    deviceGroupRepo.find.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: groupInfoRepo },
        { provide: 'REDIS_CLIENT', useValue: { srem: jest.fn(), keys: jest.fn() } },
        { provide: MessagingService, useValue: { purgeDeviceFootprint: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AppController);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('says so and stops when every base is current, without reading the roster over nothing', async () => {
    staleBuilder.getRawMany.mockResolvedValue([]);

    await run();

    expect(deviceGroupRepo.find).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('every published base names'));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('names the group, both epochs and the age, and counts who is locked out', async () => {
    staleBuilder.getRawMany.mockResolvedValue([behind('4f87267a', 13)]);
    deviceGroupRepo.find.mockResolvedValue([
      membership('4f87267a', 'active'),
      membership('4f87267a', 'pending'),
      membership('4f87267a', 'pending'),
    ]);

    await run();

    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('1 group(s)');
    expect(line).toContain('2 device(s)');
    expect(line).toContain('4f87267a(283/284, 13d)');
    // A member still holds the tree, so this one is waiting rather than dead.
    expect(error).not.toHaveBeenCalled();
  });

  it('accuses separately when NO active membership is left, because nobody can ever repair it', async () => {
    staleBuilder.getRawMany.mockResolvedValue([behind('g-waiting', 2), behind('g-dead', 40)]);
    deviceGroupRepo.find.mockResolvedValue([
      membership('g-waiting', 'active'),
      membership('g-dead', 'pending'),
    ]);

    await run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 group(s)'));
    const accusation = error.mock.calls[0][0] as string;
    expect(accusation).toContain('1 of them have NO active device membership');
    expect(accusation).toContain('g-dead');
    // And it names ONLY that half - a group with a member to wait for is not shut permanently.
    expect(accusation).not.toContain('g-waiting');
  });
});
