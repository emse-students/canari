/// <reference types="jest" />

import {
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import {
  ADDRESSABLE_PUBLISH_LUA,
  ADDRESSED_HISTORY_CAPABILITY,
  PRESENCE_SESSIONS,
} from './addressing';
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
  // Who still awaits as the lift reads it, then the lift of `awaitingAdmission` itself.
  const txAsks = jest.fn();
  const txLift = jest.fn();
  type EvictionRow = { generation: number; owedDeparture: number | null };
  /** A key-group target's `dm_seat_evictions` row when its claim is taken, before the store. */
  let claimRow: EvictionRow | null;
  /** The same row as the store's transaction re-reads it, under the seat lock. */
  let txEvictionRow: EvictionRow | null;
  /** Whether the target's key package is still there when the store re-reads it under the lock. */
  let txKeyPackage: boolean;
  /** The row of the same Welcome already queued, as the store finds it under its lock. */
  let queuedCopy: unknown;
  /**
   * `queued_message."deliveryRan"` as COMMITTED, per row id (migration 058): a row absent here reads
   * false. Written only when the transaction that claimed it ends without throwing.
   */
  const deliveryRan = new Map<string, boolean>();
  /**
   * The row lock a delivery claim holds until its transaction ends, as PostgreSQL holds it: a second
   * claim of the same row waits for it, then re-reads the committed flag.
   */
  const rowLocks = new Map<string, Promise<void>>();
  /** Every delivery claim, in the order it was ASKED - before it waits on a row lock. */
  const claimsAsked: string[] = [];
  /** Rows acknowledged by their device (deleted) before a delivery claims them. */
  const goneRows = new Set<string>();
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
    const held: { id: string; marked: boolean; release: () => void }[] = [];
    const end = (committed: boolean) => {
      for (const h of held) {
        if (committed && h.marked) deliveryRan.set(h.id, true);
        rowLocks.delete(h.id);
        h.release();
      }
    };
    /** `SELECT ... FOR UPDATE`: waits on the row lock, takes it, reads the committed row. */
    const lock = async (id: string): Promise<{ deliveryRan: boolean }[]> => {
      claimsAsked.push(id);
      for (let l = rowLocks.get(id); l; l = rowLocks.get(id)) await l;
      if (goneRows.has(id)) return [];
      let release = () => {};
      rowLocks.set(id, new Promise<void>((r) => (release = r)));
      held.push({ id, marked: false, release });
      return [{ deliveryRan: deliveryRan.get(id) === true }];
    };
    /** The UPDATE under that lock: committed with the transaction, lost with a rollback. */
    const mark = (id: string) => {
      const h = held.find((x) => x.id === id);
      if (h) h.marked = true;
      return [];
    };
    try {
      const out = await cb(txManager(lock, mark));
      end(true);
      return out;
    } catch (e) {
      end(false);
      throw e;
    }
  });
  const txManager = (
    lock: (id: string) => Promise<{ deliveryRan: boolean }[]>,
    mark: (id: string) => unknown[]
  ) => ({
    // The seat lock, and the eviction row a key-group target's claim is checked against.
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('"deliveryRan" FROM queued_message')) return lock(String(params?.[0]));
      if (sql.includes('SET "deliveryRan" = true')) return mark(String(params?.[0]));
      if (sql.includes('pg_advisory_xact_lock')) {
        const welcomeStore = String(params?.[0] ?? '').startsWith('welcome-store:');
        txReads.push(
          welcomeStore ? 'welcome-lock' : sql.includes('_shared') ? 'seat-lock-shared' : 'seat-lock'
        );
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
          // The store lifts the invitation-link ask its Welcome answers: who awaits, then the lift.
          find: jest.fn(async (q: unknown) => {
            txReads.push('lift');
            return txAsks(q);
          }),
          update: jest.fn(async (where: unknown, set: unknown) => {
            txReads.push('lift-write');
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
        // A copy of the same Welcome already queued (`findQueuedWelcome`) - none unless a case says.
        findOne: jest.fn(async () => {
          txReads.push('queued-copy');
          return queuedCopy;
        }),
        save: jest.fn(async (rows: unknown) => {
          txReads.push('save');
          return queuedSave(rows);
        }),
      };
    },
  });
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
    // The addressability script (`addressabilityOf`): 1 = every session declared the capability.
    eval: jest.fn().mockResolvedValue(1),
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
    deliveryRan.clear();
    rowLocks.clear();
    claimsAsked.length = 0;
    goneRows.clear();
    txSeat.mockResolvedValue({ id: 'm-u2' });
    txAsks.mockResolvedValue([]);
    txLift.mockResolvedValue({ affected: 0 });
    claimRow = null;
    txEvictionRow = null;
    txKeyPackage = true;
    queuedCopy = null;
    redis.eval.mockResolvedValue(1);
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
    await expect(service.sendWelcome(undefined, body)).resolves.toMatchObject({ status: 'queued' });
  });

  describe('answers whether the device can be addressed a history answer (the join push reads it)', () => {
    it('answers `addressable`, read by the check-only script: nothing is published by the read', async () => {
      await expect(service.sendWelcome(undefined, body)).resolves.toEqual({
        status: 'queued',
        addressability: 'addressable',
      });
      expect(redis.eval).toHaveBeenCalledWith(
        ADDRESSABLE_PUBLISH_LUA,
        2,
        'user:online:u2:d2',
        'addressing:sessions:u2:d2',
        '',
        '',
        ADDRESSED_HISTORY_CAPABILITY,
        PRESENCE_SESSIONS
      );
      // The Welcome's own publish, and only it.
      expect(redis.publish).toHaveBeenCalledTimes(1);
    });

    it('answers `offline` for a device with no presence key - the stale device of the 2026-11-15 run', async () => {
      redis.eval.mockResolvedValue(2);
      await expect(service.sendWelcome(undefined, body)).resolves.toEqual({
        status: 'queued',
        addressability: 'offline',
      });
    });

    it('answers `undeclared` for an online device with a session that did not declare', async () => {
      redis.eval.mockResolvedValue(0);
      await expect(service.sendWelcome(undefined, body)).resolves.toEqual({
        status: 'queued',
        addressability: 'undeclared',
      });
    });

    it('answers it on the re-send of a Welcome already queued too', async () => {
      queuedCopy = {
        id: 'q-first',
        recipientId: 'u2',
        deviceId: 'd2',
        groupId: 'g1',
        isWelcome: true,
        proto: body.welcomePayload,
        createdAt: new Date(),
      };
      redis.eval.mockResolvedValue(2);
      await expect(service.sendWelcome(undefined, body)).resolves.toEqual({
        status: 'queued',
        addressability: 'offline',
      });
    });

    it('leaves the field out when the read fails, says so at error, and still stores the Welcome', async () => {
      redis.eval.mockRejectedValueOnce(new Error('redis down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await expect(service.sendWelcome(undefined, body)).resolves.toEqual({ status: 'queued' });
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('could not be read - answered without it')
        );
        expect(redis.publish).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
    });
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
      'welcome-lock',
      'queued-copy',
      'save',
      'pending-row',
    ]);
  });

  /**
   * A WELCOME SENT APART NEVER ADMITS ITS TARGET (ADM-3): the accepted commit is the one writer of a
   * new person, and it lifts the ask in the transaction that accepts it. A seat still awaiting a
   * member's admission is one no accepted commit admitted - an Add the gate refused, or one that
   * never landed - so its Welcome is refused, nothing stored and nothing lifted.
   */
  it('refuses a Welcome to a seat still awaiting admission, and lifts nothing', async () => {
    txSeat.mockResolvedValue({ id: 'm-u2', awaitingAdmission: true });

    await expect(service.sendWelcome('u1', body)).rejects.toMatchObject({
      response: { code: 'WELCOME_TARGET_NOT_MEMBER', error: 'welcome_target_not_member' },
    });
    expect(queuedSave).not.toHaveBeenCalled();
    expect(txLift).not.toHaveBeenCalled();
    expect(txReads).not.toContain('pending-row');
  });

  it('stores a Welcome to an ADMITTED seat without touching its admission', async () => {
    txSeat.mockResolvedValue({ id: 'm-u2', awaitingAdmission: false });

    await expect(service.sendWelcome('u1', body)).resolves.toMatchObject({ status: 'queued' });
    expect(txLift).not.toHaveBeenCalled();
    expect(txAsks).not.toHaveBeenCalled();
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

  describe('the same Welcome sent again - one delivery per row, whoever hands it in', () => {
    /** The row of the first request, as a re-send finds it still queued. */
    const firstRow = {
      id: 'q-first',
      recipientId: 'u2',
      deviceId: 'd2',
      groupId: 'g1',
      isWelcome: true,
      proto: body.welcomePayload,
      createdAt: new Date(),
    };
    /**
     * Lets pending continuations run until `reached` holds - the state the test is about to assert -
     * giving up after a fixed number of turns (no clock) so a defect fails the assertion, never hangs.
     */
    const until = async (reached: () => boolean) => {
      for (let i = 0; i < 1000 && !reached(); i++) await new Promise((r) => setImmediate(r));
    };
    const published = () =>
      redis.publish.mock.calls.filter(([channel]) => channel === 'chat:messages').length;
    const deferredPushes = () =>
      jest.spyOn(
        service as unknown as { scheduleDeferredPush: (...a: unknown[]) => void },
        'scheduleDeferredPush'
      );
    const logged = (spy: jest.SpyInstance) =>
      spy.mock.calls.map(([line]: unknown[]) => String(line)).join(' | ');

    it('stores nothing, and delivers THAT row when no delivery of it ran - the first request died before it', async () => {
      queuedCopy = firstRow;

      await expect(service.sendWelcome(undefined, body)).resolves.toMatchObject({
        status: 'queued',
      });

      expect(txReads).toContain('welcome-lock');
      expect(txReads).not.toContain('save');
      expect(published()).toBe(1);
      const envelope = String(redis.publish.mock.calls[0][1]);
      expect(JSON.parse(envelope)).toMatchObject({ isWelcome: true });
      // THE queued row, by its id - never a second row.
      expect(envelope).toContain('q-first');
      expect(deliveryRan.get('q-first')).toBe(true);
    });

    it('publishes nothing when the first request already delivered the row, and re-arms its deferred push - the row is still queued', async () => {
      queuedCopy = firstRow;
      deliveryRan.set('q-first', true);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const deferred = deferredPushes().mockImplementation(() => undefined);

      await expect(service.sendWelcome(undefined, body)).resolves.toMatchObject({
        status: 'queued',
      });

      expect(txReads).not.toContain('save');
      expect(published()).toBe(0);
      expect(logged(log)).toContain('DELIVERY_ALREADY_RAN id=q-first');
      // A deploy may have killed the first request's own fallback timer: a frozen-but-online
      // Android has nothing else to wake it.
      expect(deferred).toHaveBeenCalledTimes(1);
      expect(deferred.mock.calls[0][0]).toMatchObject({ id: 'q-first' });
      log.mockRestore();
    });

    it('publishes nothing and pushes nothing for a row its device already acknowledged', async () => {
      queuedCopy = firstRow;
      goneRows.add('q-first');
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const deferred = deferredPushes().mockImplementation(() => undefined);

      await expect(service.sendWelcome(undefined, body)).resolves.toMatchObject({
        status: 'queued',
      });

      expect(published()).toBe(0);
      expect(deferred).not.toHaveBeenCalled();
      expect(logged(log)).toContain('DELIVERY_ROW_GONE id=q-first');
      log.mockRestore();
    });

    it('a re-send arriving WHILE the first request is publishing waits for it, then publishes nothing (prod 1.7.3, 2026-11-24)', async () => {
      const deferred = deferredPushes();
      // The first request is parked INSIDE its claim: its publish has not returned.
      let openPublish = () => {};
      const publishing = new Promise<number>((r) => (openPublish = () => r(1)));
      redis.publish.mockImplementationOnce(() => publishing);
      const first = service.sendWelcome(undefined, body);
      await until(() => published() === 1);
      expect(published()).toBe(1);

      // The re-send finds the first request's row still queued and hands it to the delivery.
      queuedCopy = { ...firstRow, id: 'q1' };
      const again = service.sendWelcome(undefined, body);
      await until(() => claimsAsked.length === 2);
      expect(claimsAsked).toEqual(['q1', 'q1']);
      expect(published()).toBe(1);

      openPublish();
      await expect(Promise.all([first, again])).resolves.toEqual([
        expect.objectContaining({ status: 'queued' }),
        expect.objectContaining({ status: 'queued' }),
      ]);

      // ONE publish of the row, by the request that claimed it first.
      expect(published()).toBe(1);
      expect(String(redis.publish.mock.calls[0][1])).toContain('q1');
      // Two arms of the deferred push (the first request's, the re-send's): each re-reads the row.
      expect(deferred).toHaveBeenCalledTimes(2);
    });

    it('a delivery that THREW leaves the row deliverable, and the next re-send delivers it', async () => {
      redis.publish.mockRejectedValueOnce(new Error('redis gone'));
      await expect(service.sendWelcome(undefined, body)).rejects.toThrow('redis gone');
      expect(deliveryRan.get('q1')).not.toBe(true);

      queuedCopy = { ...firstRow, id: 'q1' };
      await expect(service.sendWelcome(undefined, body)).resolves.toMatchObject({
        status: 'queued',
      });
      expect(deliveryRan.get('q1')).toBe(true);
      expect(redis.publish).toHaveBeenCalledTimes(2);
    });
  });

  it('refuses a target device that does not exist with a typed 404, never a 500', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    const refusal = await service.sendWelcome(undefined, body).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect((refusal as NotFoundException).getResponse()).toMatchObject({
      code: 'WELCOME_TARGET_UNKNOWN',
      error: 'welcome_target_unknown',
    });
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

      await expect(service.sendWelcome('u1', body)).resolves.toMatchObject({ status: 'queued' });
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

    it("does not read a key group's addressability: no join push follows a community admission", async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'ws-1' });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      social(true);

      await expect(service.sendWelcome('u1', body)).resolves.toEqual({ status: 'queued' });
      expect(redis.eval).not.toHaveBeenCalled();
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

      await expect(service.sendWelcome('u1', body)).resolves.toMatchObject({ status: 'queued' });
      expect(txReads).toEqual([
        'seat-lock-shared',
        'group',
        'claim',
        'key-package',
        'welcome-lock',
        'queued-copy',
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
      await expect(service.sendWelcome('u1', body)).resolves.toMatchObject({ status: 'queued' });
      // A seat still awaiting a member decides nothing: its holder Welcoming a device of their own
      // would lift their own ask - so the seat's flag is read, and only `admitted` passes.
      expect(groupMemberRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'g1', userId: 'u1' },
        select: { id: true, awaitingAdmission: true },
      });
    });

    it('refuses a non-member of an ordinary conversation', async () => {
      roster.delete('u1');

      await expect(service.sendWelcome('u1', body)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
