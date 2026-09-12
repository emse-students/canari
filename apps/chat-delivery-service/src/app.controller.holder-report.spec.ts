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
import { SINGLE_HOLDER_REPORT_TOP_N } from './retention.constants';

/**
 * The report's job is to be READ, so what is asserted here is the shape of what it says: which
 * half of the population lands at which level, and that the line stays one line however large the
 * population gets.
 *
 * The predicate itself lives in SQL and is not exercised here - it was measured directly against
 * production instead (2026-09-12, 58 live groups), which is the only place it could have been
 * falsified. That measurement is what produced `MIN_MEMBERS_FOR_HOLDER_REPORT`.
 */
describe('AppController - reportSingleHolderGroups', () => {
  let controller: AppController;
  let query: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  const row = (groupId: string, holders: number, activeEpoch = 3, pending = 0) => ({
    groupId,
    holders: String(holders),
    members: '2',
    pending: String(pending),
    activeEpoch,
  });

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'x' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    const groupRepo = { ...emptyRepo(), query };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    }).compile();

    controller = module.get(AppController);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** The private report, reached the way the cron reaches it. */
  const run = () =>
    (
      controller as unknown as { reportSingleHolderGroups: () => Promise<void> }
    ).reportSingleHolderGroups();

  it('says so plainly when every conversation has two holders, and accuses nobody', async () => {
    await run();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('at least two of them holding'));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('WARNs for a conversation with one holder - it still has a way out', async () => {
    query.mockResolvedValue([row('g-one', 1, 284, 6)]);

    await run();

    expect(error).not.toHaveBeenCalled();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('1 conversation(s) have exactly ONE user');
    // The pending count rides along because those devices are the cheapest second holder available.
    expect(line).toContain('g-one(epoch 284, 2 member(s), 6 pending)');
  });

  it('ERRORs for a conversation with no holder - it has already happened', async () => {
    query.mockResolvedValue([row('g-none', 0)]);

    await run();

    expect(warn).not.toHaveBeenCalled();
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('NO holder at all');
    expect(line).toContain('closed permanently');
  });

  it('separates the two causes into two lines rather than one mixed count', async () => {
    query.mockResolvedValue([row('g-none', 0), row('g-one', 1)]);

    await run();

    expect(String(warn.mock.calls[0][0])).toContain('1 conversation(s) have exactly ONE user');
    expect(String(error.mock.calls[0][0])).toContain('1 conversation(s) have NO holder');
  });

  it('caps the names at the top N but keeps the true count in the line', async () => {
    const many = Array.from({ length: SINGLE_HOLDER_REPORT_TOP_N + 5 }, (_, i) => row(`g-${i}`, 1));
    query.mockResolvedValue(many);

    await run();

    const line = String(warn.mock.calls[0][0]);
    // A report whose reader learns to skip it is the one that hides the next defect: the line stays
    // one line, and the count beside it still says how far past the cap the estate went.
    expect(line).toContain(`${SINGLE_HOLDER_REPORT_TOP_N + 5} conversation(s)`);
    expect(line).toContain(`${SINGLE_HOLDER_REPORT_TOP_N} of ${SINGLE_HOLDER_REPORT_TOP_N + 5}`);
    expect(line).not.toContain(`g-${SINGLE_HOLDER_REPORT_TOP_N}(`);
  });
});
