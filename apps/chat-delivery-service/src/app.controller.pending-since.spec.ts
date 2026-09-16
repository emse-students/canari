/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { AppController } from './app.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { OneTimeKeyPackage } from './entities/one-time-key-package.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import { PushToken } from './entities/push-token.entity';
import { MlsGroupInfo } from './entities/mls-group-info.entity';
import { MlsCommitLog } from './entities/mls-commit-log.entity';
import { MessagingService } from './services/messaging.service';
import { STALE_PENDING_INVITATION_MS, STRANDED_PENDING_MEMBERSHIP_MS } from './retention.constants';

/**
 * The two clocks that ask how long a roster seat has been waiting, and the column they must read.
 *
 * `updatedAt` is a TypeORM `@UpdateDateColumn`: it moves for every write, and the writers are OTHER
 * people's clients - a Welcome being queued, a peer confirming an invitation, the commit-path
 * activation. `detectStaleDevices` carries that rule, won by WP-GHOST-1 on this very table, and
 * both seat clocks read `updatedAt` anyway until 2026-09-14. Measured on production that day: 91
 * pending seats, the purge holding 90 inside its 14-day window, and ONE created 32 days earlier
 * whose `updatedAt` was two days old - a grace window reset by a write it had no part in, on a row
 * nothing in the schema could ever let expire.
 *
 * A mocked repository never parses a query, so what is pinned here is the PREDICATE: which column
 * each clock filters on, and that the cutoff is the constant each one owns. That is exactly the
 * fact that regressed, and exactly the fact a mock can prove.
 */
describe('AppController - the seat clocks read pendingSince, never updatedAt', () => {
  let controller: AppController;
  let logs: jest.SpyInstance[];

  const deviceGroupRepo = { find: jest.fn(), delete: jest.fn(), createQueryBuilder: jest.fn() };
  const welcomeBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const queuedMessageRepo = {
    count: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => welcomeBuilder),
  };

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

  /** The `where` the clock under test handed the repository, whatever else it passed. */
  const whereOf = (call: number) => deviceGroupRepo.find.mock.calls[call][0].where;

  const runReport = () =>
    (
      controller as unknown as { reportStrandedDeviceMemberships(): Promise<void> }
    ).reportStrandedDeviceMemberships();
  const runPurge = () =>
    (
      controller as unknown as { cleanupStalePendingInvitations(): Promise<void> }
    ).cleanupStalePendingInvitations();

  beforeEach(async () => {
    jest.clearAllMocks();
    welcomeBuilder.getRawMany.mockResolvedValue([]);
    deviceGroupRepo.find.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: { srem: jest.fn(), keys: jest.fn() } },
        { provide: MessagingService, useValue: { purgeDeviceFootprint: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AppController);
    logs = (['warn', 'error', 'log'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined)
    );
  });

  afterEach(() => logs.forEach((s) => s.mockRestore()));

  it('purges on pendingSince, and never on a column somebody else can touch', async () => {
    await runPurge();

    const where = whereOf(0);
    expect(where.status).toBe('pending');
    expect(where.pendingSince).toBeDefined();
    // THE WHOLE DEFECT IN ONE ASSERTION: a seat whose row was written by a peer is a seat whose
    // window restarted, and it restarted for ever.
    expect(where.updatedAt).toBeUndefined();
  });

  it('reports on pendingSince too - it asks the same question of the same seats', async () => {
    await runReport();

    const where = whereOf(0);
    expect(where.status).toBe('pending');
    expect(where.pendingSince).toBeDefined();
    expect(where.updatedAt).toBeUndefined();
  });

  it('gives each clock its own horizon, not one shared number', async () => {
    // The report names a seat within minutes so a broken add is visible the same hour; the purge
    // waits fourteen days because deleting the row retires the inviter-side trigger. Reading one
    // constant for both would silently move whichever was not being edited.
    const before = Date.now();
    await runPurge();
    await runReport();
    const after = Date.now();

    const purgeCutoff = (whereOf(0).pendingSince as { value: Date }).value.getTime();
    const reportCutoff = (whereOf(1).pendingSince as { value: Date }).value.getTime();

    expect(purgeCutoff).toBeGreaterThanOrEqual(before - STALE_PENDING_INVITATION_MS);
    expect(purgeCutoff).toBeLessThanOrEqual(after - STALE_PENDING_INVITATION_MS);
    expect(reportCutoff).toBeGreaterThanOrEqual(before - STRANDED_PENDING_MEMBERSHIP_MS);
    expect(reportCutoff).toBeLessThanOrEqual(after - STRANDED_PENDING_MEMBERSHIP_MS);
  });
});
