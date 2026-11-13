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
import {
  memoryAccusationLedger,
  type MemoryAccusationLedger,
} from './testing/memoryAccusationLedger';
import { SINGLE_HOLDER_REPORT_TOP_N } from './retention.constants';

/**
 * The report's job is to be READ, so what is asserted here is the shape of what it says: which
 * half of the population lands at which level, and that the line stays one line however large the
 * population gets.
 *
 * The predicate itself lives in SQL and is not exercised here - it was measured directly against
 * production instead (2026-09-12, 58 live groups), which is the only place it could have been
 * falsified. That measurement is what produced `MIN_MEMBERS_FOR_HOLDER_REPORT`. The one part of it
 * pinned here is the key-group membership rule, because losing it is silent: a key group names
 * nobody in `dm_group_members`, and a query counting only that table reports none of them - which
 * is how the report missed every key group until 2026-09-27 (run against the local estate that day:
 * both key groups went from 0 members to 2).
 */
describe('AppController - reportSingleHolderGroups', () => {
  let controller: AppController;
  /** The report's ledger; fresh per test, shared by every run within one. */
  let ledger: MemoryAccusationLedger;
  let query: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  const row = (
    groupId: string,
    holders: number,
    activeEpoch = 3,
    pending = 0,
    keyGroup = false
  ) => ({
    groupId,
    holders: String(holders),
    members: '2',
    pending: String(pending),
    activeEpoch,
    keyGroup,
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
    ledger = memoryAccusationLedger();
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    const groupRepo = { ...emptyRepo(), query, manager: ledger };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
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

  it('counts a key group by its device rows, because dm_group_members names nobody in one', async () => {
    await run();

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(
      /WHEN g\."distributionWorkspaceId" IS NOT NULL\s+OR g\."distributionChannelId" IS NOT NULL\s+THEN COUNT\(DISTINCT m\."userId"\)/
    );
  });

  it('names a key group as one, since it has no Welcome fallback', async () => {
    query.mockResolvedValue([row('k-one', 1, 7, 0, true)]);

    await run();

    expect(String(warn.mock.calls[0][0])).toContain(
      'k-one(key group, epoch 7, 2 member(s), 0 pending)'
    );
  });

  describe('each conversation is accused ONCE per holder count (report_accusations)', () => {
    it('does not re-accuse a closed conversation the next hour, even when its epoch moved', async () => {
      query.mockResolvedValue([row('g-none', 0, 1)]);
      await run();
      query.mockResolvedValue([row('g-none', 0, 1)]);
      await run();

      expect(error).toHaveBeenCalledTimes(1);

      query.mockResolvedValue([row('g-one', 1, 284)]);
      await run();
      query.mockResolvedValue([row('g-one', 1, 290)]);
      await run();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('accuses again, at ERROR, a conversation that loses its last holder', async () => {
      query.mockResolvedValue([row('g-a', 1, 9)]);
      await run();
      expect(warn).toHaveBeenCalledTimes(1);

      query.mockResolvedValue([row('g-a', 0, 9)]);
      await run();

      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0][0]);
      expect(line).toContain('1 conversation(s) have NO holder at all');
      expect(line).toContain('g-a(epoch 9');
    });

    it('names only the new one, and says how many are known', async () => {
      query.mockResolvedValue([row('g-old', 0)]);
      await run();
      query.mockResolvedValue([row('g-old', 0), row('g-new', 0)]);
      await run();

      const line = String(error.mock.calls[1][0]);
      expect(line).toContain('1 conversation(s) have NO holder');
      expect(line).toContain('g-new(');
      expect(line).not.toContain('g-old(');
      expect(line).toContain('1 conversation(s) accused earlier, unchanged');
    });

    it('logs a conversation that regained a second holder once at LOG, and forgets it', async () => {
      query.mockResolvedValue([row('g-heal', 1)]);
      await run();
      query.mockResolvedValue([]);
      await run();
      await run();

      const healed = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('no longer reported'));
      expect(healed).toHaveLength(1);
      expect(healed[0]).toContain('g-heal(holders 1, accused ');
      expect(ledger.rows.get('holders')?.size).toBe(0);
    });
  });
});
