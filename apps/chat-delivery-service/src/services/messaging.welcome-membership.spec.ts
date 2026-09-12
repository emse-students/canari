/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

/**
 * `sendWelcome` HAD NO TEST AT ALL, WHICH IS HOW IT SPENT ITS LIFE DEMOTING ACTIVE MEMBERS.
 *
 * Two invariants are asserted here, and neither was expressible while the function wrote both
 * columns and the routing set in one breath:
 *
 * 1. **A Welcome never demotes.** The conflict clause touches `kickedAt` and nothing else, so a
 *    row that is already `active` keeps its status. A demoted row is dropped by the fan-out
 *    (`WHERE status = 'active'`) and the device silently stops receiving the group.
 * 2. **A Welcome never writes the routing set.** `group:members:{groupId}` is owned by
 *    `activateDeviceMembership`; a second writer here announced a device as routable in the same
 *    breath as recording that it had not joined.
 */
describe('MessagingService - sendWelcome does not touch membership status or the routing set', () => {
  let service: MessagingService;

  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const deviceGroupRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };

  const keyPackageRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 'kp-1', userId: 'u2', deviceId: 'd2' }),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  };

  // The Welcome row is written through a transaction that first takes a read lock on the group, so
  // a group deleted mid-flight queues nothing. A live group keeps that path inert here.
  const queuedSave = jest.fn().mockImplementation(async (rows: unknown) => rows);
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
    cb({
      getRepository: (entity: unknown) =>
        entity === Group
          ? { find: jest.fn().mockResolvedValue([{ id: 'g1', deletedAt: null }]) }
          : { save: queuedSave },
    })
  );
  const queuedMessageRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: queuedSave,
    delete: jest.fn(),
    create: jest.fn().mockImplementation((e: Record<string, unknown>) => ({ id: 'q1', ...e })),
    manager: { transaction },
  };

  const redis = {
    // The target is online, so the Welcome takes the realtime publish branch and no FCM is needed.
    exists: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn(),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const body = {
    targetDeviceId: 'd2',
    targetUserId: 'u2',
    senderUserId: 'u1',
    groupId: 'g1',
    welcomePayload: 'V0VMQ09NRQ==',
    ratchetTreePayload: 'VFJFRQ==',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    keyPackageRepo.findOne.mockResolvedValue({ id: 'kp-1', userId: 'u2', deviceId: 'd2' });
    deviceGroupRepo.createQueryBuilder.mockReturnValue(insertBuilder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(Group),
          useValue: { ...emptyRepo(), manager: { transaction } },
        },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
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
  });

  it('queues the Welcome and reports it', async () => {
    await expect(service.sendWelcome(undefined, body)).resolves.toEqual({ status: 'queued' });
  });

  it('overwrites ONLY `kickedAt` on conflict, so an active row is never demoted', async () => {
    await service.sendWelcome(undefined, body);

    // THE REGRESSION THIS FILE EXISTS FOR. The previous `upsert` overwrote `status` with the
    // literal 'pending', and `skipUpdateIfNoValuesChanged` does not spare a row whose value
    // changes - so a Welcome to an already-active device knocked it out of the fan-out.
    expect(insertBuilder.orUpdate).toHaveBeenCalledWith(['kickedAt'], ['deviceId', 'groupId']);
    const [overwritten] = insertBuilder.orUpdate.mock.calls[0];
    expect(overwritten).not.toContain('status');
  });

  it('still inserts a `pending` row when the device has none (bootstrap)', async () => {
    await service.sendWelcome(undefined, body);

    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'd2',
        groupId: 'g1',
        userId: 'u2',
        status: 'pending',
        kickedAt: null,
      })
    );
  });

  it('never adds the device to the gateway routing set', async () => {
    await service.sendWelcome(undefined, body);

    // `group:members:{groupId}` is owned by activateDeviceMembership, which writes it at the
    // pending->active transition. A Welcome is a delivery, not a promotion: writing the set here
    // told the gateway to broadcast to - and to elect as an answerer - a device that had not
    // joined, while SQL recorded it as `pending` and skipped it.
    const setWrites = redis.sadd.mock.calls.filter(([key]) =>
      String(key).startsWith('group:members:')
    );
    expect(setWrites).toHaveLength(0);
  });

  it('publishes the Welcome in realtime when the target is online', async () => {
    await service.sendWelcome(undefined, body);

    expect(redis.exists).toHaveBeenCalledWith('user:online:u2:d2');
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, envelope] = redis.publish.mock.calls[0];
    expect(channel).toBe('chat:messages');
    expect(JSON.parse(String(envelope))).toMatchObject({
      recipientId: 'u2',
      deviceId: 'd2',
      groupId: 'g1',
      isWelcome: true,
    });
  });

  it('refuses a target device that does not exist', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    await expect(service.sendWelcome(undefined, body)).rejects.toThrow(/not found/);
    expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });
});
