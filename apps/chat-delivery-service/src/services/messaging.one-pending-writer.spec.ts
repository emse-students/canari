/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { AppController } from '../app.controller';
import { InvitationsController } from '../controllers/invitations.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

/**
 * ONE WRITER FOR `-> pending`, ASSERTED AS ONE WRITER AND AS THREE DOORS.
 *
 * The sibling of `messaging.one-active-writer.spec.ts`, and the other half of the entity
 * docblock's invariant. Four paths made this transition and they split on the one thing that has a
 * consequence:
 *
 * | Path | Redis SREM | `kickedAt` | Inserts if absent |
 * | --- | --- | --- | --- |
 * | `kickStaleDevice` | written | set | no |
 * | `kickStaleUser` | **never written** | set | no |
 * | `detectStaleDevices` (cron) | written | left as is | no |
 * | `updateInvitationStatus` demotion | **never written** | left as is | yes - none of the four since 2026-10-25 |
 *
 * THE TWO MISSING SREMS DO NOT HEAL. Nothing removes an extra entry from
 * `group:members:{groupId}`: the SEND reconciliation only `sadd`s, so an entry naming a device
 * that is no longer active survives every message the group sends. The gateway ELECTS the answerer
 * of a `welcome_request` and a `history_request` from that set, so `kickStaleUser` - whose whole
 * purpose is that a member just removed those leaves - left every one of them electable to serve a
 * Welcome for a group they could no longer open, until the stale-pending cron deleted the row
 * fourteen days later. Silent throughout: a routing set that is merely TOO LARGE is not empty, and
 * no election door reloads it.
 *
 * `kickedAt` IS NOT PART OF THAT DIVERGENCE and is deliberately not fused away. The column answers
 * one question - is this row waiting on a re-add that a kick promised? - and each of the four wrote
 * it the way that question requires. What the fusion changes is that the answer is now REQUIRED at
 * every call site (`removedFromTreeAt`) instead of being given by omission, which is exactly how
 * `kickStaleUser` came to be silent about the SREM.
 *
 * **The decomposition, deliberately**, and the same as the sibling's: the one writer's OWN
 * behaviour is asserted against a real `MessagingService`; each door is asserted to DELEGATE and to
 * have stopped writing the row and the set itself. Re-asserting the `srem` at each door would
 * re-pin the duplication this deletes. WHICH ANSWER each door gives to `removedFromTreeAt` is a
 * question about the stranded report rather than about the fusion, and it is pinned where that
 * report's discriminator already lives: `controllers/invitations.controller.kick-marker.spec.ts`.
 */
describe('the ONE writer of a pending membership', () => {
  let service: MessagingService;

  const redis = {
    srem: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
  };
  const deviceGroupRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    redis.srem.mockResolvedValue(1);
    deviceGroupRepo.update.mockResolvedValue({ affected: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    const holder = service as unknown as {
      logger: { log: (m: string) => void; warn: (m: string) => void };
    };
    jest.spyOn(holder.logger, 'log').mockImplementation(() => {});
    jest.spyOn(holder.logger, 'warn').mockImplementation(() => {});
  });

  /** The values the demotion's UPDATE wrote, from its one call. */
  const written = () => deviceGroupRepo.update.mock.calls[0][1] as Record<string, unknown>;

  it('writes the row AND removes from the routing set - the two facts an unroutable device needs', async () => {
    await expect(
      service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: null })
    ).resolves.toBe(true);

    expect(deviceGroupRepo.update).toHaveBeenCalledWith(
      { userId: 'u1', deviceId: 'd1', groupId: 'g1' },
      expect.objectContaining({ status: 'pending' })
    );
    expect(redis.srem).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
  });

  it('records the kick when a member removed the leaf', async () => {
    const at = new Date('2026-09-13T09:41:00Z');

    await service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: at });

    expect(written()).toMatchObject({ kickedAt: at });
  });

  it('LEAVES `kickedAt` alone when nobody removed the leaf, rather than clearing it', async () => {
    await service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: null });

    // The distinction the whole column exists for. The UPDATE's SET list is the keys of this
    // object, so spelling `kickedAt: null` would erase the proof of a kick on every cron demotion -
    // the opposite of what the stranded report needs. Absence is what preserves it.
    expect(written()).not.toHaveProperty('kickedAt');
  });

  it('RESTARTS the seat clock, because a demotion restarts the wait', async () => {
    // The fresh grace window the purge always intended a demoted device to have, and could not
    // give it: `cleanupStalePendingInvitations` was reading `updatedAt`, which somebody else's
    // write moves. `pendingSince` is written here and by the column default, and nowhere else -
    // unlike `kickedAt`, it is unconditional, because both branches of this call put the row in
    // `pending` right now.
    const before = Date.now();
    await service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: null });
    const after = Date.now();

    const { pendingSince } = written() as { pendingSince: Date };
    expect(pendingSince).toBeInstanceOf(Date);
    expect(pendingSince.getTime()).toBeGreaterThanOrEqual(before);
    expect(pendingSince.getTime()).toBeLessThanOrEqual(after);
  });

  it('restarts it on a KICK too - the device is waiting on a re-add either way', async () => {
    await service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: new Date(0) });

    const { pendingSince, kickedAt } = written() as { pendingSince: Date; kickedAt: Date };
    // The two clocks answer different questions and must not be confused: one says when the wait
    // started, the other whether a kick promised an Add.
    expect(kickedAt).toEqual(new Date(0));
    expect(pendingSince.getTime()).toBeGreaterThan(0);
  });

  it('completes even when Redis throws - the row is the truth and a demotion must always land', async () => {
    redis.srem.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: null })
    ).resolves.toBe(true);
    expect(deviceGroupRepo.update).toHaveBeenCalled();
  });

  it('never creates a seat: with no row it writes nothing, still drops the route, and says so', async () => {
    deviceGroupRepo.update.mockResolvedValue({ affected: 0 });

    await expect(
      service.deactivateDeviceMembership('u1', 'd1', 'g1', { removedFromTreeAt: null })
    ).resolves.toBe(false);
    // An UPDATE, never an insert: a seat a departure deleted stays deleted.
    expect(deviceGroupRepo).not.toHaveProperty('upsert');
    expect(redis.srem).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
  });
});

describe('the KICK and INVITATION_STATUS doors', () => {
  let controller: InvitationsController;
  const messaging = {
    activateDeviceMembership: jest.fn().mockResolvedValue({ ok: true }),
    deactivateDeviceMembership: jest.fn().mockResolvedValue(true),
    deviceAddressability: jest.fn().mockResolvedValue({ ok: true }),
  };
  const deviceGroupRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
  };
  const redis = { srem: jest.fn().mockResolvedValue(1), mget: jest.fn() };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn().mockImplementation((e: unknown) => e),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    deviceGroupRepo.findOne.mockResolvedValue(null);
    deviceGroupRepo.find.mockResolvedValue([]);
    messaging.deactivateDeviceMembership.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupInvite), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InvitationsController);
  });

  it('kick-stale-user delegates EVERY device, which is how the missing SREM disappears', async () => {
    deviceGroupRepo.find.mockResolvedValue([
      { userId: 'u1', deviceId: 'd1', groupId: 'g1' },
      { userId: 'u1', deviceId: 'd2', groupId: 'g1' },
    ]);

    const answer = await controller.kickStaleUser({ userId: 'u1', groupId: 'g1' }, 'u1', 'true');

    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledTimes(2);
    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      'g1',
      expect.objectContaining({ tag: 'KICK_USER' })
    );
    // The local batch save is what left both devices in the routing set; it must be gone.
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
    expect(answer.affected).toBe(2);
  });

  it('kick-stale-device delegates, and stops writing the routing set itself', async () => {
    deviceGroupRepo.findOne.mockResolvedValue({ userId: 'u1', deviceId: 'd1', groupId: 'g1' });

    await controller.kickStaleDevice({ deviceId: 'd1', userId: 'u1', groupId: 'g1' }, 'u1', 'true');

    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      'g1',
      expect.objectContaining({ tag: 'KICK_DEVICE' })
    );
    // This door was the ONLY kick that got the `srem` right, and that is exactly why it must stop
    // doing it here: one correct copy of a rule is still a copy.
    expect(redis.srem).not.toHaveBeenCalled();
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
  });

  it('the kicks name the row they read, and count only what was demoted', async () => {
    deviceGroupRepo.find.mockResolvedValue([
      { id: 's1', userId: 'u1', deviceId: 'd1', groupId: 'g1' },
      { id: 's2', userId: 'u1', deviceId: 'd2', groupId: 'g1' },
    ]);
    // d2's row was deleted between the read and the write.
    messaging.deactivateDeviceMembership.mockImplementation(
      async (_u: string, d: string) => d === 'd1'
    );

    const user = await controller.kickStaleUser({ userId: 'u1', groupId: 'g1' }, 'u1', 'true');

    expect(user).toMatchObject({ affected: 1, devices: [{ deviceId: 'd1', groupId: 'g1' }] });
    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd2',
      'g1',
      expect.objectContaining({ seatId: 's2' })
    );

    deviceGroupRepo.findOne.mockResolvedValue({
      id: 's2',
      userId: 'u1',
      deviceId: 'd2',
      groupId: 'g1',
    });
    await expect(
      controller.kickStaleDevice({ deviceId: 'd2', userId: 'u1', groupId: 'g1' }, 'u1', 'true')
    ).resolves.toEqual({ status: 'not_found', affected: 0 });
  });

  it('kick-stale-device still writes nothing for a membership that does not exist', async () => {
    deviceGroupRepo.findOne.mockResolvedValue(null);

    const answer = await controller.kickStaleDevice(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1' },
      'u1',
      'true'
    );

    expect(answer).toEqual({ status: 'not_found', affected: 0 });
    expect(messaging.deactivateDeviceMembership).not.toHaveBeenCalled();
  });

  it('the self-reported demotion delegates with NO kick - nobody removed this leaf', async () => {
    const answer = await controller.updateInvitationStatus(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'pending' },
      'u1',
      'false'
    );

    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      'g1',
      expect.objectContaining({ tag: 'INVITATION_STATUS' })
    );
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
    expect(answer).toEqual({ status: 'pending' });
  });

  it('the self-reported demotion of a seat that does not exist is the no_seat refusal', async () => {
    messaging.deactivateDeviceMembership.mockResolvedValue(false);

    const refusal = (await controller
      .updateInvitationStatus(
        { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'pending' },
        'u1',
        'false'
      )
      .catch((e: unknown) => e)) as { getStatus(): number; getResponse(): unknown };

    expect(refusal.getStatus()).toBe(403);
    expect(refusal.getResponse()).toMatchObject({ code: 'NOT_A_MEMBER', reason: 'no_seat' });
  });
});

describe('the CRON door', () => {
  let appController: AppController;
  const messaging = { deactivateDeviceMembership: jest.fn().mockResolvedValue(true) };
  const redis = { srem: jest.fn().mockResolvedValue(1) };

  const STALE = {
    userId: 'u1',
    deviceId: 'd1',
    groupId: 'g1',
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  };

  const deviceGroupRepo = {
    createQueryBuilder: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const keyPackageRepo = { find: jest.fn().mockResolvedValue([]) };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    keyPackageRepo.find.mockResolvedValue([]);
    deviceGroupRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([STALE]),
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    appController = module.get(AppController);
    const holder = appController as unknown as { logger: { log: (m: string) => void } };
    jest.spyOn(holder.logger, 'log').mockImplementation(() => {});
  });

  const sweep = () =>
    (appController as unknown as { detectStaleDevices: () => Promise<void> }).detectStaleDevices();

  it('demotes a device with no live KeyPackage through the one writer, with NO kick recorded', async () => {
    await sweep();

    expect(messaging.deactivateDeviceMembership).toHaveBeenCalledWith('u1', 'd1', 'g1', {
      removedFromTreeAt: null,
      tag: 'CRON_STALE_DEVICE',
    });
    // Recording a kick here would make the hourly stranded report accuse a member of an Add
    // nobody ever promised: this device was not removed, it stopped republishing a KeyPackage.
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it('leaves a device that reconnected inside the window alone', async () => {
    keyPackageRepo.find.mockResolvedValue([{ userId: 'u1', deviceId: 'd1' }]);

    await sweep();

    expect(messaging.deactivateDeviceMembership).not.toHaveBeenCalled();
  });
});
