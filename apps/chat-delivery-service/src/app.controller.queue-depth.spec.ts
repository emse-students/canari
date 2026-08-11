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
import { MessagingService } from './services/messaging.service';
import { QUEUE_DEPTH_WARN_PER_DEVICE } from './retention.constants';

/**
 * `reportQueueDepth` is the platform's only witness that one device's undelivered queue is
 * running away - the state that put 28 124 frames on a single web device on 2026-08-10 with
 * nothing said about it anywhere.
 *
 * What is pinned here is the DECISION, not the SQL: a mocked repository never parses a query,
 * so the builder's output is only ever verified by a real Postgres (the prod deploy log). What
 * a mock CAN prove, and what would silently regress, is that the threshold separates the two
 * regimes and that the WARN carries the liveness evidence a reader needs to tell a client bug
 * from ordinary debris.
 */
describe('AppController - reportQueueDepth', () => {
  let controller: AppController;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  const depthBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const queuedMessageRepo = {
    count: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => depthBuilder),
  };
  const keyPackageRepo = { find: jest.fn().mockResolvedValue([]), query: jest.fn() };

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

  /** Invoke the private cron body the same way the scheduler does. */
  const run = () =>
    (controller as unknown as { reportQueueDepth(): Promise<void> }).reportQueueDepth();

  beforeEach(async () => {
    jest.clearAllMocks();
    keyPackageRepo.find.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: { srem: jest.fn(), keys: jest.fn() } },
        { provide: MessagingService, useValue: { purgeDeviceFootprint: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AppController);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('says so and stops when the queue is empty, without grouping over nothing', async () => {
    queuedMessageRepo.count.mockResolvedValue(0);

    await run();

    expect(queuedMessageRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('queue empty'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an ordinary queue without warning about it', async () => {
    queuedMessageRepo.count.mockResolvedValue(126);
    depthBuilder.getRawMany.mockResolvedValue([
      { deviceId: 'web-a', depth: '84', oldest: new Date('2026-08-09T10:00:00Z') },
      { deviceId: 'web-b', depth: '42', oldest: new Date('2026-08-10T10:00:00Z') },
    ]);

    await run();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('126 frame(s) queued'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('web-a=84'));
    expect(warn).not.toHaveBeenCalled();
    // No offender means no reason to go looking for liveness evidence.
    expect(keyPackageRepo.find).not.toHaveBeenCalled();
  });

  it('warns only about the devices at or past the threshold', async () => {
    queuedMessageRepo.count.mockResolvedValue(30_000);
    depthBuilder.getRawMany.mockResolvedValue([
      { deviceId: 'web-runaway', depth: String(QUEUE_DEPTH_WARN_PER_DEVICE), oldest: new Date() },
      {
        deviceId: 'web-fine',
        depth: String(QUEUE_DEPTH_WARN_PER_DEVICE - 1),
        oldest: new Date(),
      },
    ]);

    await run();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('device=web-runaway'));
  });

  it('carries the last KeyPackage upload in the warning, because that is what names the cause', async () => {
    const oldest = new Date('2026-08-10T13:00:00Z');
    const lastSeen = new Date('2026-08-10T19:47:00Z');
    queuedMessageRepo.count.mockResolvedValue(29_499);
    depthBuilder.getRawMany.mockResolvedValue([
      { deviceId: 'web-runaway', depth: '29499', oldest },
    ]);
    keyPackageRepo.find.mockResolvedValue([{ deviceId: 'web-runaway', createdAt: lastSeen }]);

    await run();

    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain(`oldest=${oldest.toISOString()}`);
    expect(line).toContain(`lastKeyPackage=${lastSeen.toISOString()}`);
  });

  it('reports a runaway device with no KeyPackage at all rather than skipping it', async () => {
    queuedMessageRepo.count.mockResolvedValue(9000);
    depthBuilder.getRawMany.mockResolvedValue([
      { deviceId: 'ghost', depth: '9000', oldest: new Date('2026-08-01T00:00:00Z') },
    ]);
    keyPackageRepo.find.mockResolvedValue([]);

    await run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lastKeyPackage=none'));
  });
});
