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
import { stubQueryBuilder } from './testing/queryBuilder';

/**
 * `reclaimExpiredKeyPackages` DELETES ONE TABLE AND ONLY REPORTS THE OTHER, and the asymmetry is
 * the entire design.
 *
 * A one-time package is spent by the first Welcome built on it, so a row still in the pool was
 * never handed out and nothing holds a private half waiting for it. Past its lifetime every joiner
 * would refuse the Welcome anyway, so deleting it costs nobody a join - and the device's own
 * keystore drops the matching private bundle by the same expiry, so the two ends agree without
 * having to talk.
 *
 * The static last-resort row cannot be deleted for the reason it exists: it is what the resolver
 * falls back on, and `getUserDevices` reads this table, so removing it would make the device
 * UNINVITABLE rather than merely unjoinable. Only its owner can repair the state, by minting and
 * re-registering on its next connection. So that half is a REPORT - and it is the first thing in
 * this estate able to see the condition at all. On 2026-09-16 four rows were aged and two accounts
 * had a join stuck on one; the only thing that found them was a query written by hand.
 */
describe('AppController - reclaimExpiredKeyPackages', () => {
  let controller: AppController;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

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

  let otkpBuilder: ReturnType<typeof stubQueryBuilder>;
  let fallbackBuilders: ReturnType<typeof stubQueryBuilder>[];
  const otkpRepo = emptyRepo();
  const keyPackageRepo = emptyRepo();

  /** Invoke the private cron body the same way the scheduler does. */
  const run = () =>
    (
      controller as unknown as { reclaimExpiredKeyPackages(): Promise<void> }
    ).reclaimExpiredKeyPackages();

  /**
   * `deleted` one-time rows reclaimed, `stale` the aged last-resort rows the report names.
   *
   * The job asks the key-package table twice - the sample, then the total - so the stub hands out a
   * builder per call in that order.
   */
  const estate = (
    deleted: number,
    // The same row shape the job's own `getRawMany` declares. It said `{ userId, deviceId,
    // notAfter }` while every fixture below passed `createdAt` as well - which the job reads to
    // tell a REPORTED expiry from a PROVEN one. Only the two literals passed inline were refused;
    // the 40-row fixture went through `.slice()`, where excess-property checking does not apply.
    stale: { userId: string; deviceId: string; notAfter: Date | null; createdAt: Date }[]
  ) => {
    otkpBuilder = stubQueryBuilder({ execute: { affected: deleted } });
    fallbackBuilders = [
      stubQueryBuilder({ getRawMany: stale }),
      stubQueryBuilder({ getCount: stale.length }),
    ];
    otkpRepo.createQueryBuilder.mockReturnValue(otkpBuilder);
    let nth = 0;
    keyPackageRepo.createQueryBuilder.mockImplementation(() => fallbackBuilders[nth++]);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    estate(0, []);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: otkpRepo },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
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
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('deletes the one-time rows past their lifetime and says how many', async () => {
    estate(171, []);
    await run();

    const where = otkpBuilder.calls.find((c) => c.method === 'where');
    expect(String(where?.args[0])).toContain('<= now()');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deleted 171 one-time package(s)'));
  });

  it('judges an undated row by its own row age rather than skipping it', async () => {
    // THIS USED TO ASSERT `"notAfter" IS NOT NULL`, and that exemption is what let the population
    // grow: undated rows arrived at ~290 a day on production on 2026-09-18, every one written AFTER
    // migration 024 backfilled the table, and none of them was ever swept. The fear behind it - that
    // sweeping the undated would empty the pools of devices no fact exists about - does not apply to
    // THIS table, whose rows are inserted once and never updated, so `createdAt + 84 days` IS the
    // package's lifetime. A young undated row is still untouched; only one past that sum is taken.
    await run();
    const where = otkpBuilder.calls.find((c) => c.method === 'where');
    expect(String(where?.args[0])).not.toContain('IS NOT NULL');
    expect(String(where?.args[0])).toContain('COALESCE("notAfter"');
    expect(String(where?.args[0])).toContain("interval '84 days'");
  });

  it('says nothing at all on a clean estate', async () => {
    await run();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('NAMES the devices holding an expired last-resort, because the repair is per device', async () => {
    const elapsed = new Date('2026-09-14T08:00:00.000Z');
    estate(0, [
      { userId: 'u1', deviceId: 'd1', notAfter: elapsed, createdAt: elapsed },
      { userId: 'u2', deviceId: 'd2', notAfter: elapsed, createdAt: elapsed },
    ]);
    await run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 device(s) hold an EXPIRED'));
    // WHICH ARM NAMED IT travels with the name: a reported date is the package's own lifetime,
    // where a proven one is only the row-age bound that outlived it, and the repair differs.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('u1/d1@reported:2026-09-14T08:00:00.000Z')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('u2/d2@reported:2026-09-14T08:00:00.000Z')
    );
  });

  it('caps the names it prints but not the number it reports', async () => {
    // A bad day must not become a log flood, and a capped list must not become a lie about scale.
    const stale = Array.from({ length: 40 }, (_, i) => ({
      userId: `u${i}`,
      deviceId: `d${i}`,
      notAfter: new Date('2026-09-14T08:00:00.000Z'),
      createdAt: new Date('2026-09-14T08:00:00.000Z'),
    }));
    estate(0, stale.slice(0, 20));
    fallbackBuilders[1] = stubQueryBuilder({ getCount: 40 });
    let nth = 0;
    keyPackageRepo.createQueryBuilder.mockImplementation(() => fallbackBuilders[nth++]);

    await run();

    const limit = fallbackBuilders[0].calls.find((c) => c.method === 'limit');
    expect(limit?.args[0]).toBe(20);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('40 device(s) hold an EXPIRED'));
  });

  it('is in the initial sweep, so a deployment reports the estate it inherits', async () => {
    // A daily job on a service that restarts more often than daily runs on nobody's schedule.
    const jobs = (
      controller as unknown as { runInitialSweep(): Promise<void> }
    ).runInitialSweep.toString();
    expect(jobs).toContain('reclaimExpiredKeyPackages');
  });
});
