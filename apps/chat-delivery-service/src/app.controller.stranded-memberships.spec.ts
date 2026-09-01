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

/**
 * `reportStrandedDeviceMemberships` is the platform's only witness that a device holds a group
 * roster seat it was never given the keys for.
 *
 * The state it names cost a real conversation its notifications on 2026-09-01: a phone was
 * registered into a brand-new DM at 20:45:47, never received a Welcome, and sat there looking like
 * a member - receiving nothing, notifying nothing - for 3 h 41. Nothing anywhere said so; it was
 * found by reading the tables by hand.
 *
 * WHAT IS PINNED HERE IS THE PARTITION, not the SQL. A mocked repository never parses a query, so
 * the builder's output is only ever verified by a real Postgres. What a mock CAN prove, and what
 * would silently regress, is that a `pending` row awaiting a QUEUED Welcome is read as healthy
 * while one with no Welcome at all is named - because that single fact is the entire difference
 * between an offline device and a broken add, and the row itself cannot carry it.
 */
describe('AppController - reportStrandedDeviceMemberships', () => {
  let controller: AppController;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  const welcomeBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const queuedMessageRepo = {
    count: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => welcomeBuilder),
  };
  const deviceGroupRepo = {
    find: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
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

  /** A `pending` device membership older than the report window. */
  const pending = (deviceId: string, groupId: string, updatedAt: Date) => ({
    userId: 'u1',
    deviceId,
    groupId,
    status: 'pending' as const,
    updatedAt,
  });

  /** Invoke the private cron body the same way the scheduler does. */
  const run = () =>
    (
      controller as unknown as { reportStrandedDeviceMemberships(): Promise<void> }
    ).reportStrandedDeviceMemberships();

  beforeEach(async () => {
    jest.clearAllMocks();
    welcomeBuilder.getRawMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
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

  it('says so and stops when nothing is pending, without querying the queue over nothing', async () => {
    deviceGroupRepo.find.mockResolvedValue([]);

    await run();

    expect(queuedMessageRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no pending membership'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a pending row whose Welcome is queued as healthy, and warns about nothing', async () => {
    deviceGroupRepo.find.mockResolvedValue([pending('web-offline', 'g1', new Date())]);
    welcomeBuilder.getRawMany.mockResolvedValue([{ deviceId: 'web-offline', groupId: 'g1' }]);

    await run();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 awaiting a queued Welcome'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0 with no Welcome ever queued'));
    // An offline device is not a defect, and a report that cried about one would be skipped.
    expect(warn).not.toHaveBeenCalled();
  });

  it('names a device that was registered and never added', async () => {
    deviceGroupRepo.find.mockResolvedValue([pending('tauri-stranded', 'g1', new Date())]);
    welcomeBuilder.getRawMany.mockResolvedValue([]);

    await run();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('tauri-stranded@g1');
    expect(line).toContain('no Welcome ever queued');
  });

  it('matches the Welcome on the GROUP too, not on the device alone', async () => {
    // The same device legitimately holds a queued Welcome for another group. Keying the exclusion
    // on the deviceId alone would read this device as healthy everywhere it appears, which is how
    // a per-group defect hides behind an unrelated healthy row.
    deviceGroupRepo.find.mockResolvedValue([pending('tauri-a', 'g-broken', new Date())]);
    welcomeBuilder.getRawMany.mockResolvedValue([{ deviceId: 'tauri-a', groupId: 'g-other' }]);

    await run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tauri-a@g-broken'));
  });

  it('prints both halves of the partition, so the threshold can be re-measured from the log', async () => {
    deviceGroupRepo.find.mockResolvedValue([
      pending('web-offline', 'g1', new Date()),
      pending('tauri-stranded', 'g2', new Date()),
    ]);
    welcomeBuilder.getRawMany.mockResolvedValue([{ deviceId: 'web-offline', groupId: 'g1' }]);

    await run();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('2 pending membership(s) past the window')
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 awaiting a queued Welcome'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 with no Welcome ever queued'));
  });

  it('names the OLDEST stranded rows, which is the axis that separates a defect from a blip', async () => {
    const old = new Date('2026-09-01T20:45:47Z');
    const recent = new Date('2026-09-02T09:00:00Z');
    deviceGroupRepo.find.mockResolvedValue([
      pending('recent-device', 'g2', recent),
      pending('oldest-device', 'g1', old),
    ]);

    await run();

    const line = warn.mock.calls[0][0] as string;
    expect(line.indexOf('oldest-device')).toBeLessThan(line.indexOf('recent-device'));
    expect(line).toContain(old.toISOString());
  });

  it('deletes nothing - the fourteen-day purge owns that, and this only witnesses it', async () => {
    deviceGroupRepo.find.mockResolvedValue([pending('tauri-stranded', 'g1', new Date())]);

    await run();

    expect(deviceGroupRepo.delete).not.toHaveBeenCalled();
    expect(queuedMessageRepo.delete).not.toHaveBeenCalled();
  });
});
