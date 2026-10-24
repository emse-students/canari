/// <reference types="jest" />

import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
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
 * 1. **A Welcome never touches an existing row.** It neither demotes an `active` row - a demoted
 *    row is dropped by the fan-out (`WHERE status = 'active'`) - nor clears a kick: the commit that
 *    admits the device does that, and a Welcome is bytes, not an Add.
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
    orIgnore: jest.fn().mockReturnThis(),
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
  /** Every read inside the store's transaction, in order, so a test can see what was locked when. */
  const txReads: string[] = [];
  // The target's roster seat as the store's transaction re-reads it, under a lock.
  const txSeat = jest.fn();
  // The lift of `awaitingAdmission` the store makes for the Welcome's target.
  const txLift = jest.fn();
  type EvictionRow = { generation: number; owedDeparture: number | null };
  /** A key-group target's `dm_seat_evictions` row when its claim is taken, before the store. */
  let claimRow: EvictionRow | null;
  /** The same row as the store's transaction re-reads it, under the seat lock. */
  let txEvictionRow: EvictionRow | null;
  /** Whether the target's key package is still there when the store re-reads it under the lock. */
  let txKeyPackage: boolean;
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
    cb({
      // The seat lock, and the eviction row a key-group target's claim is checked against.
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          txReads.push(sql.includes('_shared') ? 'seat-lock-shared' : 'seat-lock');
          return [];
        }
        if (sql.includes('FROM dm_seat_evictions')) {
          txReads.push('claim');
          return txEvictionRow ? [txEvictionRow] : [];
        }
        return [];
      }),
      getRepository: (entity: unknown) => {
        if (entity === Group) {
          return {
            find: jest.fn(async () => {
              txReads.push('group');
              return [{ id: 'g1', deletedAt: null }];
            }),
          };
        }
        if (entity === GroupMember) {
          return {
            findOne: jest.fn(async (q: unknown) => {
              txReads.push('seat');
              return txSeat(q);
            }),
            // The store lifts the invitation-link ask its Welcome answers.
            update: jest.fn(async (where: unknown, set: unknown) => {
              txReads.push('lift');
              return txLift(where, set);
            }),
          };
        }
        if (entity === DeviceGroupMembership) {
          return {
            createQueryBuilder: jest.fn(() => {
              txReads.push('pending-row');
              return insertBuilder;
            }),
          };
        }
        // The target's key package, read FOR SHARE before its pending row is inserted.
        if (entity === KeyPackage) {
          return {
            find: jest.fn(async () => {
              txReads.push('key-package');
              return txKeyPackage ? [{ userId: 'u2', deviceId: 'd2' }] : [];
            }),
          };
        }
        return {
          save: jest.fn(async (rows: unknown) => {
            txReads.push('save');
            return queuedSave(rows);
          }),
        };
      },
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

  // Held as consts so the authorization cases below can say what each table answers.
  const groupMemberRepo = emptyRepo();
  // `query` answers a key-group target's seat claim, read before social-service is asked.
  const claimQuery = jest.fn(async (sql: string) =>
    sql.includes('FROM dm_seat_evictions') && claimRow ? [claimRow] : []
  );
  const groupRepo = { ...emptyRepo(), manager: { transaction, query: claimQuery } };
  // The conversation's user roster, which `dm_group_members` answers from.
  let roster: Set<string>;

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
    txReads.length = 0;
    txSeat.mockResolvedValue({ id: 'm-u2' });
    txLift.mockResolvedValue({ affected: 0 });
    claimRow = null;
    txEvictionRow = null;
    txKeyPackage = true;
    keyPackageRepo.findOne.mockResolvedValue({ id: 'kp-1', userId: 'u2', deviceId: 'd2' });
    deviceGroupRepo.createQueryBuilder.mockReturnValue(insertBuilder);
    deviceGroupRepo.findOne.mockResolvedValue(null);
    roster = new Set(['u1', 'u2']);
    groupMemberRepo.findOne.mockImplementation(
      async ({ where }: { where: { groupId: string; userId: string } }) =>
        where.groupId === 'g1' && roster.has(where.userId) ? { id: `m-${where.userId}` } : null
    );
    groupRepo.findOne.mockResolvedValue({ id: 'g1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
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

  it('leaves an existing row alone: an active row is not demoted, a kicked one not cleared', async () => {
    await service.sendWelcome(undefined, body);

    // THE REGRESSION THIS FILE EXISTS FOR. An `upsert` overwrote `status` with the literal
    // 'pending', which knocked an active device out of the fan-out; its successor overwrote
    // `kickedAt`, which let a Welcome undo a kick no commit had answered.
    expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
    expect(insertBuilder.orUpdate).not.toHaveBeenCalled();
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses a conversation Welcome to a device whose owner is not on the group's roster", async () => {
    roster.delete('u2');

    await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
      response: { error: 'welcome_target_not_member' },
    });
    // Nothing is queued and no membership row is written for the outsider's device.
    expect(queuedSave).not.toHaveBeenCalled();
    expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  /**
   * A REMOVAL RACING THE STORE: the seat was there when the target was checked, and the removal
   * committed before the store's transaction re-read it. The store re-reads it under a share lock
   * IN its own transaction, after the group, so the two serialise: a removal that committed first
   * leaves no seat and nothing is stored; one that comes second waits, then deletes the Welcome.
   */
  it("re-reads the target's seat under a lock in the transaction that stores the Welcome", async () => {
    await service.sendWelcome('u1', body);

    expect(txSeat).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: 'u2' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(txReads).toEqual([
      'seat-lock-shared',
      'group',
      'seat',
      'key-package',
      'save',
      'pending-row',
      // The invitation-link ask its Welcome answers, lifted in the same transaction.
      'lift',
    ]);
  });

  /**
   * A WELCOME STORED BY AN ADMITTED MEMBER ADMITS ITS TARGET: the ask an invitation link wrote is
   * lifted with it, whatever client sent it - one older than `admits` declares nobody in its commit,
   * and this is the one door that still sees its Add.
   */
  it("lifts the target's invitation-link ask, guarded on the flag, in the store's transaction", async () => {
    txLift.mockResolvedValueOnce({ affected: 1 });

    await expect(service.sendWelcome('u1', body)).resolves.toEqual({ status: 'queued' });

    expect(txLift).toHaveBeenCalledTimes(1);
    const [where, set] = txLift.mock.calls[0] as [
      { groupId: string; userId: { value: string[] }; awaitingAdmission: boolean },
      unknown,
    ];
    expect(where.groupId).toBe('g1');
    expect(where.awaitingAdmission).toBe(true);
    expect(where.userId.value).toEqual(['u2']);
    expect(set).toEqual({ awaitingAdmission: false });
  });

  /**
   * THE PENDING ROW IS A SEAT, SO IT IS WRITTEN WITH THE WELCOME, UNDER THE SAME LOCK. Written after
   * the store's transaction, an eviction committing in between left a pending row behind for a
   * person it had just cut off.
   */
  it('writes the pending row in the transaction that stores the Welcome', async () => {
    await service.sendWelcome('u1', body);

    expect(txReads.indexOf('pending-row')).toBeGreaterThan(txReads.indexOf('save'));
    expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the seat is gone by the time the transaction reads it', async () => {
    txSeat.mockResolvedValue(null);

    await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
      response: { error: 'welcome_target_not_member' },
    });
    expect(queuedSave).not.toHaveBeenCalled();
    expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  // An account erasure deletes the key packages first: a pending row inserted after it would name
  // an erased account with nothing left to find it.
  it('stores nothing when the target key package is gone by the time the transaction reads it', async () => {
    txKeyPackage = false;

    await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
      response: { error: 'welcome_target_not_member' },
    });
    expect(queuedSave).not.toHaveBeenCalled();
    expect(txReads).not.toContain('pending-row');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('refuses it on the background route too, which names no header', async () => {
    roster.delete('u2');

    await expect(service.sendWelcome(undefined, body)).rejects.toMatchObject({
      response: { error: 'welcome_target_not_member' },
    });
    expect(queuedSave).not.toHaveBeenCalled();
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

  /**
   * WHOEVER ADMITS A COMMUNITY NEWCOMER WELCOMES THEM (channel-encryption section 20), and a
   * key-distribution group names nobody in `dm_group_members` by construction. Asked of that table,
   * the gate refused every such Welcome; it asks the device table for this kind, like the replay.
   */
  describe('who may send a Welcome', () => {
    let previous: string | undefined;
    let fetchSpy: jest.SpyInstance;
    /** social-service's answer for the Welcome's target (WP-KEYGROUP-JOIN-GATE). */
    const social = (entitled: boolean) =>
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ entitled }), { status: 200 }));

    beforeEach(() => {
      previous = process.env.INTERNAL_SECRET;
      process.env.INTERNAL_SECRET = 'sekret';
      fetchSpy = jest.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = previous;
    });

    it('lets a key-distribution member with an ACTIVE device row Welcome an entitled newcomer', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(true);

      await expect(service.sendWelcome('u1', body)).resolves.toEqual({ status: 'queued' });
      expect(deviceGroupRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'g1', userId: 'u1', status: 'active' },
      });
      // The user table cannot answer for this kind, so it is not asked at all: social-service is,
      // about the TARGET.
      expect(groupMemberRepo.findOne).not.toHaveBeenCalled();
      expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
        kind: 'workspace',
        scopeId: 'ws-1',
        userId: 'u2',
      });
    });

    /**
     * A KEY GROUP'S SEAT IS SOCIAL-SERVICE'S ANSWER, TAKEN AGAINST A CLAIM. The claim is read
     * before the question; the store re-reads it under the seat lock the eviction takes, so an
     * eviction that commits between the answer and the store is seen, and nothing is stored.
     */
    it('takes the seat lock before the group row and re-reads the claim under it', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(true);

      await expect(service.sendWelcome('u1', body)).resolves.toEqual({ status: 'queued' });
      expect(txReads).toEqual([
        'seat-lock-shared',
        'group',
        'claim',
        'key-package',
        'save',
        'pending-row',
      ]);
      // The claim is read before social-service is asked.
      const claimRead = claimQuery.mock.calls.findIndex(([sql]) =>
        String(sql).includes('FROM dm_seat_evictions')
      );
      expect(claimRead).toBeGreaterThanOrEqual(0);
      expect(claimQuery.mock.invocationCallOrder[claimRead]).toBeLessThan(
        fetchSpy.mock.invocationCallOrder[0]
      );
    });

    it('stores nothing when the target is evicted after social-service answered', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(true);
      // The eviction committed after the claim was read: its generation moved.
      txEvictionRow = { generation: 1, owedDeparture: null };

      await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
        response: { error: 'welcome_target_not_member' },
      });
      expect(queuedSave).not.toHaveBeenCalled();
      expect(insertBuilder.values).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("stores nothing while the target's departure is in progress", async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(true);
      claimRow = { generation: 1, owedDeparture: 1 };
      txEvictionRow = { generation: 1, owedDeparture: 1 };

      await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
        response: { error: 'welcome_target_not_member' },
      });
      expect(queuedSave).not.toHaveBeenCalled();
      expect(insertBuilder.values).not.toHaveBeenCalled();
    });

    it("refuses a key group's Welcome to a target social-service does not entitle", async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionChannelId: 'salon-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(false);

      await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
        response: { error: 'welcome_target_not_member' },
      });
      expect(queuedSave).not.toHaveBeenCalled();
      expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("is a 503 - nothing queued, no row - when social-service cannot answer for a key group's target", async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await expect(service.sendWelcome('u1', body)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
      expect(queuedSave).not.toHaveBeenCalled();
      expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a sender with no active device in a private salon key group', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionChannelId: 'salon-1' });

      await expect(service.sendWelcome('u1', body)).rejects.toBeInstanceOf(ForbiddenException);
      expect(queuedSave).not.toHaveBeenCalled();
    });

    it('still asks dm_group_members for an ordinary conversation - an ADMITTED seat only', async () => {
      await expect(service.sendWelcome('u1', body)).resolves.toEqual({ status: 'queued' });
      // A seat still awaiting a member decides nothing: its holder Welcoming a device of their own
      // would lift their own ask.
      expect(groupMemberRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'g1', userId: 'u1', awaitingAdmission: false },
      });
    });

    it('refuses a non-member of an ordinary conversation', async () => {
      roster.delete('u1');

      await expect(service.sendWelcome('u1', body)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
