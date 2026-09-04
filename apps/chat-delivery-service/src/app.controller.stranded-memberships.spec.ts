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
  let error: jest.SpyInstance;
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

  /**
   * A `pending` device membership older than the report window.
   *
   * `kickedAt` defaults to `null`, which is what every row written before that column existed says
   * and what a device registered-but-never-added says: no kick promised this row an Add.
   */
  const pending = (
    deviceId: string,
    groupId: string,
    updatedAt: Date,
    kickedAt: Date | null = null
  ) => ({
    userId: 'u1',
    deviceId,
    groupId,
    status: 'pending' as const,
    updatedAt,
    kickedAt,
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
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0 never added'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0 kicked with no re-add'));
    // An offline device is not a defect, and a report that cried about one would be skipped.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 never added'));
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

  /**
   * THE SECOND HALF OF THE PARTITION, AND THE ONLY PLACE A FAILING ADD IS EVER REPORTED.
   *
   * A member that finds a stale leaf removes it and undertakes to put the device back. When that Add
   * throws, the failure is swallowed on the answering device - a phone, whose log nobody reads - and
   * server-side the row it leaves is byte-identical to one belonging to a device that was never
   * added at all. Same footprint, opposite fixes: one sends its reader to the inviter's KeyPackage
   * handling, the other to whatever made the Add throw.
   *
   * `kickedAt` is the discriminator, written by the kick and cleared by the Welcome that proves the
   * Add landed. These cases pin that the two halves are counted apart, accused apart, and dated by
   * the clock that belongs to each.
   */
  describe('the kicked half', () => {
    const kickedAt = new Date('2026-09-01T10:18:38Z');

    it('accuses a kicked row at ERROR, and does not call it never-added', async () => {
      deviceGroupRepo.find.mockResolvedValue([pending('tauri-kicked', 'g1', new Date(), kickedAt)]);

      await run();

      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const line = error.mock.calls[0][0] as string;
      expect(line).toContain('tauri-kicked@g1');
      expect(line).toContain('KICKED and never');
      // Dated by the kick: the age that matters is how long the promise has been outstanding.
      expect(line).toContain(kickedAt.toISOString());
    });

    it('reports the two causes separately when both are present', async () => {
      deviceGroupRepo.find.mockResolvedValue([
        pending('tauri-never', 'g1', new Date()),
        pending('tauri-kicked', 'g2', new Date(), kickedAt),
      ]);

      await run();

      expect(log).toHaveBeenCalledWith(expect.stringContaining('1 never added'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('1 kicked with no re-add'));
      expect(warn.mock.calls[0][0] as string).toContain('tauri-never@g1');
      expect(warn.mock.calls[0][0] as string).not.toContain('tauri-kicked');
      expect(error.mock.calls[0][0] as string).toContain('tauri-kicked@g2');
      expect(error.mock.calls[0][0] as string).not.toContain('tauri-never');
    });

    it('says nothing about a kicked row whose Welcome IS queued - the re-add landed', async () => {
      // The queued Welcome is the proof, and it outranks the marker: a successful kick-and-re-add
      // must not be reported as a failed one for as long as the row stays pending. The clearing
      // write lives in `queueWelcome`; this pins that the report does not accuse it in the window
      // before that write is visible either.
      deviceGroupRepo.find.mockResolvedValue([pending('tauri-kicked', 'g1', new Date(), kickedAt)]);
      welcomeBuilder.getRawMany.mockResolvedValue([{ deviceId: 'tauri-kicked', groupId: 'g1' }]);

      await run();

      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('1 awaiting a queued Welcome'));
    });

    it('names the oldest KICKS first, by the kick clock and not by the row clock', async () => {
      // The two clocks disagree on purpose here: the row touched most recently carries the OLDEST
      // outstanding promise. Sorting by `updatedAt` would put them the wrong way round.
      const oldKick = new Date('2026-08-30T01:00:00Z');
      const newKick = new Date('2026-09-01T01:00:00Z');
      deviceGroupRepo.find.mockResolvedValue([
        pending('recent-kick', 'g1', new Date('2026-08-30T02:00:00Z'), newKick),
        pending('oldest-kick', 'g2', new Date('2026-09-01T02:00:00Z'), oldKick),
      ]);

      await run();

      const line = error.mock.calls[0][0] as string;
      expect(line.indexOf('oldest-kick')).toBeLessThan(line.indexOf('recent-kick'));
    });
  });

  it('deletes nothing - the fourteen-day purge owns that, and this only witnesses it', async () => {
    deviceGroupRepo.find.mockResolvedValue([pending('tauri-stranded', 'g1', new Date())]);

    await run();

    expect(deviceGroupRepo.delete).not.toHaveBeenCalled();
    expect(queuedMessageRepo.delete).not.toHaveBeenCalled();
  });
});
