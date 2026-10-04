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
import { COMMIT_LOG_REPORT_TOP_N, COMMIT_RATE_WARN_PER_DEVICE_HOUR } from './retention.constants';

/**
 * The commit-log report is read, so what is pinned is what it SAYS: the distribution line is
 * printed every hour whatever the verdict, the WARN reads the busiest single committer rather than
 * the group total, a hole is an ERROR naming its first missing epoch, and each stays one line.
 *
 * The SQL is not executed by a mocked repository. The two properties that make it the right SQL are
 * pinned on its text instead: the hole span starts at the oldest RETAINED commit (a pruned floor is
 * not a hole), and both queries are grouped in the database rather than looped per group here.
 */
describe('AppController - reportCommitLogHealth', () => {
  let controller: AppController;
  let rateRows: unknown[];
  let holeRows: unknown[];
  let query: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  const rate = (groupId: string, commits: number, committers: number, topCommits: number) => ({
    groupId,
    commits: String(commits),
    committers: String(committers),
    topCommits: String(topCommits),
    topCommitter: `web-${groupId}`,
    keyGroup: false,
    activeEpoch: 104,
  });

  const hole = (groupId: string, firstHole: number, recorded: number, activeEpoch = 130) => ({
    groupId,
    activeEpoch,
    floorEpoch: 0,
    recorded: String(recorded),
    firstHole,
    holeAfter: new Date('2026-08-31T10:00:00Z'),
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
    rateRows = [];
    holeRows = [];
    query = jest.fn((sql: string) =>
      Promise.resolve(sql.includes('per_committer') ? rateRows : holeRows)
    );

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: { ...emptyRepo(), query } },
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
      controller as unknown as { reportCommitLogHealth: () => Promise<void> }
    ).reportCommitLogHealth();

  const logged = () => log.mock.calls.map((c) => String(c[0]));

  it('says both halves are clean when nothing committed and no log has a hole', async () => {
    await run();

    expect(logged()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('commit rate over the last hour - no group committed'),
        expect.stringContaining('every commit log is contiguous'),
      ])
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('prints the whole distribution every hour, even when nothing is past the threshold', async () => {
    rateRows = [rate('g-a', 3, 2, 2), rate('g-b', 1, 1, 1), rate('g-c', 5, 5, 1)];

    await run();

    const line = logged().find((l) => l.includes('commit rate over the last hour - 9 commit(s)'));
    expect(line).toBeDefined();
    expect(line).toContain('in 3 group(s)');
    expect(line).toContain('per group p50=3 p90=5 max=5');
    expect(line).toContain('busiest single committer per group p50=1 p90=2 max=2');
    expect(line).toContain(`0 group(s) at >= ${COMMIT_RATE_WARN_PER_DEVICE_HOUR} by one device`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('WARNs on ONE device re-keying a group, naming it with the evidence', async () => {
    rateRows = [rate('g-churn', 16, 1, 16)];

    await run();

    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(`1 group(s) were re-keyed ${COMMIT_RATE_WARN_PER_DEVICE_HOUR} or more`);
    expect(line).toContain('g-churn(epoch 104, 16 commit(s) by 1 device(s), web-g-churn x16)');
  });

  it('does not accuse a group that many devices joined - that is growth, not churn', async () => {
    rateRows = [rate('g-community', 30, 30, 1)];

    await run();

    expect(warn).not.toHaveBeenCalled();
  });

  it('holds the boundary: one commit under the threshold is quiet, the threshold itself is not', async () => {
    rateRows = [rate('g-under', 7, 1, COMMIT_RATE_WARN_PER_DEVICE_HOUR - 1)];
    await run();
    expect(warn).not.toHaveBeenCalled();

    rateRows = [rate('g-at', 8, 1, COMMIT_RATE_WARN_PER_DEVICE_HOUR)];
    await run();
    expect(String(warn.mock.calls[0][0])).toContain('g-at(');
  });

  it('caps the names at the top N but keeps the true count in the line', async () => {
    rateRows = Array.from({ length: COMMIT_LOG_REPORT_TOP_N + 3 }, (_, i) =>
      rate(`g-${i}`, 20, 1, 20)
    );

    await run();

    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(`${COMMIT_LOG_REPORT_TOP_N + 3} group(s) were re-keyed`);
    expect(line).toContain(`${COMMIT_LOG_REPORT_TOP_N} of ${COMMIT_LOG_REPORT_TOP_N + 3}`);
    expect(line).not.toContain(`g-${COMMIT_LOG_REPORT_TOP_N}(`);
  });

  it('ERRORs on a hole, naming its first missing epoch and how many are missing', async () => {
    // DM `7da231f8` as measured on 2026-09-02: epochs 0..129 recorded except 121.
    holeRows = [hole('g-7da231f8', 121, 129, 130)];

    await run();

    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('1 group(s) have a HOLE in their commit log');
    expect(line).toContain('g-7da231f8(first hole at 121, 1 missing, log 0..129');
    expect(line).toContain('after 2026-08-31T10:00:00.000Z');
  });

  it('reads the span from the oldest RETAINED commit, so a pruned floor is never a hole', async () => {
    await run();

    const sql = String(query.mock.calls.find((c) => String(c[0]).includes('LEAD('))?.[0]);
    // The span is walked over the rows that exist, from their minimum: nothing compares against 0.
    expect(sql).toContain('MIN("baseEpoch")');
    expect(sql).toMatch(/"nextEpoch" > "baseEpoch" \+ 1/);
    expect(sql).toMatch(/"nextEpoch" IS NULL AND "baseEpoch" < "activeEpoch" - 1/);
    // One grouped query over the estate, never one per group.
    expect(sql).toContain('GROUP BY "groupId"');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
