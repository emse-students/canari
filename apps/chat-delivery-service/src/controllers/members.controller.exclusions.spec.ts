/// <reference types="jest" />

import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MembersController } from './members.controller';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14). The server's half is a record and a
 * read: removal closes the person's membership interval in the transaction that deletes their row,
 * and `GET mls/groups/:groupId/exclusions` hands the gaps to a CURRENT member - and to nobody else.
 */
describe('MembersController - membership intervals and the exclusions read', () => {
  let controller: MembersController;
  let members: Array<{ userId: string; joinedAt: Date }>;
  let intervals: Array<{ userId: string; joinedAt: Date; leftAt: Date | null }>;
  let healInserts: Array<{ userId: string; joinedAt: Date; leftAt: null }>;
  let txDeletes: Array<{ entity: unknown; where: unknown }>;
  let txUpdates: Array<{ entity: unknown; where: Record<string, unknown> }>;
  let intervalFind: jest.Mock;
  let deviceRows: Array<{ userId: string; deviceId: string; createdAt?: Date; status?: string }>;
  let deviceQuery: string[];
  let order: string[];
  let failTx: boolean;
  let redis: { smembers: jest.Mock; srem: jest.Mock; hset: jest.Mock };
  let group: {
    isGroup: boolean;
    distributionWorkspaceId?: string | null;
    distributionChannelId?: string | null;
    createdAt?: Date;
  } | null;

  const T = (iso: string) => new Date(iso);

  beforeEach(async () => {
    group = { isGroup: true, distributionWorkspaceId: null, distributionChannelId: null };
    members = [
      { userId: 'alice', joinedAt: T('2026-10-01T00:00:00Z') },
      { userId: 'bob', joinedAt: T('2026-10-05T00:00:00Z') },
      { userId: 'carol', joinedAt: T('2026-10-07T00:00:00Z') },
    ];
    intervals = [
      { userId: 'alice', joinedAt: T('2026-10-01T00:00:00Z'), leftAt: null },
      // bob: removed on the 3rd, re-added on the 5th
      { userId: 'bob', joinedAt: T('2026-10-01T00:00:00Z'), leftAt: T('2026-10-03T00:00:00Z') },
      { userId: 'bob', joinedAt: T('2026-10-05T00:00:00Z'), leftAt: null },
      { userId: 'carol', joinedAt: T('2026-10-07T00:00:00Z'), leftAt: null },
    ];
    txDeletes = [];
    txUpdates = [];
    failTx = false;
    intervalFind = jest.fn(() => Promise.resolve(intervals));
    order = [];
    deviceQuery = [];
    deviceRows = [
      { userId: 'alice', deviceId: 'a1' },
      { userId: 'bob', deviceId: 'b1' },
      { userId: 'bob', deviceId: 'b2' },
      { userId: 'carol', deviceId: 'c1' },
    ];
    redis = {
      smembers: jest.fn().mockResolvedValue([]),
      srem: jest.fn(),
      hset: jest.fn(async () => {
        order.push('parting-recorded');
        return 2;
      }),
    };

    const txManager = {
      getRepository: (entity: unknown) => ({
        delete: (where: unknown) => {
          txDeletes.push({ entity, where });
          if (entity === DeviceGroupMembership) {
            order.push('devices-deleted');
            const { userId } = where as { userId: string };
            deviceRows = deviceRows.filter((d) => d.userId !== userId);
          }
          return Promise.resolve({ affected: 1 });
        },
        update: (where: Record<string, unknown>) => {
          if (failTx) return Promise.reject(new Error('serialization failure'));
          order.push('interval-closed');
          txUpdates.push({ entity, where });
          return Promise.resolve({ affected: 1 });
        },
      }),
    };
    healInserts = [];
    const healBuilder = {
      insert: () => healBuilder,
      into: () => healBuilder,
      values: (rows: Array<{ userId: string; joinedAt: Date; leftAt: null }>) => {
        healInserts.push(...rows);
        return healBuilder;
      },
      orIgnore: () => healBuilder,
      returning: () => healBuilder,
      // The real insert lands in the table the next read comes from, and RETURNING names it.
      execute: () => {
        const stored = healInserts.map(({ userId, joinedAt, leftAt }) => ({
          userId,
          joinedAt,
          leftAt,
        }));
        intervals.push(...stored);
        return Promise.resolve({
          raw: stored.map(({ userId, joinedAt }) => ({ userId, joinedAt })),
        });
      },
    };
    // The repair's own transaction: the roster read under its lock, then the insert.
    const healTx = {
      getRepository: () => ({
        createQueryBuilder: () => {
          let ids: string[] = [];
          const qb = {
            select: () => qb,
            addSelect: () => qb,
            where: () => qb,
            andWhere: (_sql: string, p: { userIds: string[] }) => {
              ids = p.userIds;
              return qb;
            },
            setLock: () => qb,
            getRawMany: async () =>
              members
                .filter((m) => ids.includes(m.userId))
                .map((m) => ({ userId: m.userId, joinedAt: m.joinedAt })),
          };
          return qb;
        },
      }),
      createQueryBuilder: () => healBuilder,
    };
    const dataSource = {
      manager: {
        find: intervalFind,
        transaction: (fn: (m: unknown) => Promise<unknown>) => fn(healTx),
      },
      // A failed transaction rolls back: the device rows it deleted are there again.
      transaction: async (fn: (m: unknown) => Promise<unknown>) => {
        const before = [...deviceRows];
        try {
          return await fn(txManager);
        } catch (e) {
          deviceRows = before;
          throw e;
        }
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        {
          provide: getRepositoryToken(GroupMember),
          useValue: {
            find: jest.fn(() => Promise.resolve(members)),
            count: jest.fn(({ where }: { where: { userId?: string } }) =>
              Promise.resolve(members.filter((m) => m.userId === where.userId).length)
            ),
          },
        },
        { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: { findOne: jest.fn(async () => group) } },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: {
            find: jest.fn(({ where }: { where: { userId?: string } }) =>
              Promise.resolve(
                deviceRows.filter((d) => where.userId === undefined || d.userId === where.userId)
              )
            ),
            delete: jest.fn(async ({ userId }: { userId: string }) => {
              order.push('devices-deleted');
              deviceRows = deviceRows.filter((d) => d.userId !== userId);
              return { affected: 2 };
            }),
            // The exclusions read: each user holding a device row, whatever its status, with the
            // earliest and the latest row's time.
            // Every clause is recorded, so a test can assert what the SQL does NOT filter on.
            createQueryBuilder: () => {
              const qb = {
                select: (c: string) => (deviceQuery.push(c), qb),
                addSelect: (c: string) => (deviceQuery.push(c), qb),
                where: (c: string) => (deviceQuery.push(c), qb),
                andWhere: (c: string) => (deviceQuery.push(c), qb),
                groupBy: (c: string) => (deviceQuery.push(c), qb),
                getRawMany: async () =>
                  [...new Set(deviceRows.map((d) => d.userId))].map((userId) => {
                    const times = deviceRows
                      .filter((d) => d.userId === userId && d.createdAt)
                      .map((d) => (d.createdAt as Date).getTime());
                    return {
                      userId,
                      firstDeviceAt: times.length > 0 ? new Date(Math.min(...times)) : null,
                      lastDeviceAt: times.length > 0 ? new Date(Math.max(...times)) : null,
                    };
                  }),
              };
              return qb;
            },
          },
        },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: DataSource, useValue: dataSource },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MembersController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers a current member with the gaps of EVERY current member that has one', async () => {
    const got = await controller.getGroupExclusions('g-1', 'alice');

    // bob's gap, and nobody else: alice never left, and carol's late arrival is not a GAP - the span
    // before it is in `withheld`, which the legacy field does not carry.
    expect(got.exclusions).toEqual({
      bob: [
        { from: T('2026-10-03T00:00:00Z').getTime(), until: T('2026-10-05T00:00:00Z').getTime() },
      ],
    });
    expect(intervalFind).toHaveBeenCalledWith(GroupMembershipInterval, expect.anything());
  });

  it('withholds, in a GROUP conversation, everything before the person arrived, then their gaps', async () => {
    const got = await controller.getGroupExclusions('g-1', 'bob');

    expect(got.withheld).toEqual({
      bob: [
        { from: 0, until: T('2026-10-01T00:00:00Z').getTime() },
        { from: T('2026-10-03T00:00:00Z').getTime(), until: T('2026-10-05T00:00:00Z').getTime() },
      ],
    });
    // The union field keeps its meaning for a broadcast answer.
    expect(Object.keys(got.exclusions)).toEqual(['bob']);
  });

  it('withholds nothing before the arrival of the person who arrived WITH the group - the creator', async () => {
    // alice's interval opened 4 ms after the group row, as measured on the local estate.
    group = { ...group!, createdAt: new Date(T('2026-10-01T00:00:00Z').getTime() - 4) };

    expect((await controller.getGroupExclusions('g-1', 'alice')).withheld).toEqual({ alice: [] });
    // A member who joined later keeps the span before their own arrival.
    expect((await controller.getGroupExclusions('g-1', 'carol')).withheld).toEqual({
      carol: [{ from: 0, until: T('2026-10-07T00:00:00Z').getTime() }],
    });
  });

  /** carol's device was added on the 7th, after alice arrived - as at an inviter's push. */
  const carolAdded = (status: 'pending' | 'active') => {
    deviceRows = deviceRows.map((d) =>
      d.userId === 'carol' ? { ...d, createdAt: T('2026-10-07T00:00:00Z'), status } : d
    );
  };

  it("names the caller and the `for` person ONLY - nobody else's arrival leaves the server", async () => {
    carolAdded('pending');
    const got = await controller.getGroupExclusions('g-1', 'alice', 'CAROL');

    expect(got.withheld).toEqual({
      alice: [{ from: 0, until: T('2026-10-01T00:00:00Z').getTime() }],
      // carol arrived on the 7th: nothing before it is hers (user, 2026-10-21).
      carol: [{ from: 0, until: T('2026-10-07T00:00:00Z').getTime() }],
    });
  });

  it('still answers `for` once the invitee has processed its Welcome - the row is ACTIVE mid-push', async () => {
    // The invitee promotes itself as soon as its Welcome lands, while the push may still be reading
    // its windows chunk by chunk. A status predicate starved the push here.
    carolAdded('active');
    const got = await controller.getGroupExclusions('g-1', 'alice', 'carol');

    expect(got.withheld.carol).toEqual([{ from: 0, until: T('2026-10-07T00:00:00Z').getTime() }]);
    // The mock ignores the SQL, so the SQL is asserted too: no status filter may creep back in.
    expect(deviceQuery.length).toBeGreaterThan(0);
    expect(deviceQuery.join(' ')).not.toMatch(/status/i);
  });

  it("answers `for` a founding member's NEW device, added after the caller arrived", async () => {
    // alice has been in since the 1st; her new phone joins on the 9th and carol pushes to it.
    deviceRows = [
      ...deviceRows.map((d) =>
        d.userId === 'carol' ? { ...d, createdAt: T('2026-10-07T00:00:00Z') } : d
      ),
      { userId: 'alice', deviceId: 'a2', createdAt: T('2026-10-09T00:00:00Z'), status: 'active' },
    ];
    const got = await controller.getGroupExclusions('g-1', 'carol', 'alice');

    expect(got.withheld.alice).toEqual([{ from: 0, until: T('2026-10-01T00:00:00Z').getTime() }]);
  });

  it('answers `for` nothing about a member whose devices all predate the caller - a probe learns no arrival', async () => {
    // carol arrived on the 7th; alice's only device dates from the 1st, and bob's carry no date.
    deviceRows = deviceRows.map((d) =>
      d.userId === 'alice'
        ? { ...d, createdAt: T('2026-10-01T00:00:00Z') }
        : d.userId === 'carol'
          ? { ...d, createdAt: T('2026-10-07T00:00:00Z') }
          : d
    );
    const fromCarol = await controller.getGroupExclusions('g-1', 'carol', 'alice');
    const aboutBob = await controller.getGroupExclusions('g-1', 'carol', 'bob');

    expect(Object.keys(fromCarol.withheld)).toEqual(['carol']);
    expect(Object.keys(aboutBob.withheld)).toEqual(['carol']);
  });

  it('gives a counted person an EMPTY entry, so a missing key can only mean "not counted"', async () => {
    group = { isGroup: false };
    const got = await controller.getGroupExclusions('g-1', 'alice', 'nobody');

    // alice has no gap in a 1:1, and is still named; `nobody` is not counted and is absent.
    expect(got.withheld).toEqual({ alice: [] });
  });

  it("takes a person's EARLIER device row as their arrival when the interval was recorded late", async () => {
    // carol's device entered the tree on the 2nd; her interval only says the 7th (a pre-030 re-add,
    // or an invitee whose admitted row waited for them: added = arrived).
    deviceRows = deviceRows.map((d) =>
      d.userId === 'carol' ? { ...d, createdAt: T('2026-10-02T00:00:00Z'), status: 'pending' } : d
    );
    const got = await controller.getGroupExclusions('g-1', 'alice', 'carol');
    expect(got.withheld.carol).toEqual([{ from: 0, until: T('2026-10-02T00:00:00Z').getTime() }]);
  });

  it('withholds the gaps only in a 1:1, and in a key group', async () => {
    // bob's second device was added on the 6th, after alice arrived.
    deviceRows = deviceRows.map((d) =>
      d.deviceId === 'b2' ? { ...d, createdAt: T('2026-10-06T00:00:00Z'), status: 'pending' } : d
    );
    group = { isGroup: false };
    const oneToOne = await controller.getGroupExclusions('g-1', 'alice', 'bob');
    expect(oneToOne.withheld).toEqual({ alice: [], bob: oneToOne.exclusions.bob });
    group = { isGroup: true, distributionWorkspaceId: 'ws-1' };
    const keyGroup = await controller.getGroupExclusions('g-1', 'alice', 'bob');
    expect(keyGroup.withheld).toEqual({ alice: [], bob: keyGroup.exclusions.bob });
  });

  it('heals a member with no open interval ONCE - the window before it is answered, and the ERROR is not repeated', async () => {
    // dave was removed on the 2nd, then re-added on the 4th by a pre-030 container that wrote his
    // member row and no interval.
    members.push({ userId: 'dave', joinedAt: T('2026-10-04T00:00:00Z') });
    intervals.push({
      userId: 'dave',
      joinedAt: T('2026-10-01T00:00:00Z'),
      leftAt: T('2026-10-02T00:00:00Z'),
    });
    const error = jest.spyOn(controller['logger'], 'error');

    const first = await controller.getGroupExclusions('g-1', 'alice');

    expect(healInserts).toEqual([
      { groupId: 'g-1', userId: 'dave', joinedAt: T('2026-10-04T00:00:00Z'), leftAt: null },
    ]);
    expect(first.exclusions.dave).toEqual([
      { from: T('2026-10-02T00:00:00Z').getTime(), until: T('2026-10-04T00:00:00Z').getTime() },
    ]);
    expect(error).toHaveBeenCalledTimes(1);

    const second = await controller.getGroupExclusions('g-1', 'alice');
    expect(second.exclusions.dave).toEqual(first.exclusions.dave);
    // The repaired state is what stops the line - no in-memory "already said" flag.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('logs nothing at info on an ordinary read - a read on every history answer is not news', async () => {
    const info = jest.spyOn(controller['logger'], 'log');
    await controller.getGroupExclusions('g-1', 'alice');
    expect(info).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a CURRENT member - a removed one included', async () => {
    await expect(controller.getGroupExclusions('g-1', 'mallory')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(intervalFind).not.toHaveBeenCalled();
  });

  it('refuses an unidentified caller - no legacy pass-through on this route', async () => {
    await expect(controller.getGroupExclusions('g-1', undefined)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(intervalFind).not.toHaveBeenCalled();
  });

  it('a removal deletes the live row AND closes the interval in one transaction', async () => {
    await controller.removeGroupMember('g-1', 'bob', 'alice', undefined);

    expect(txDeletes).toContainEqual({
      entity: GroupMember,
      where: { groupId: 'g-1', userId: 'bob' },
    });
    expect(txUpdates).toHaveLength(1);
    expect(txUpdates[0].entity).toBe(GroupMembershipInterval);
    expect(txUpdates[0].where).toMatchObject({ groupId: 'g-1', userId: 'bob' });
  });

  it('a removal takes the Welcomes still queued for the removed person, in the same transaction', async () => {
    // A queued Welcome is pulled by its device whatever the roster says: left behind, it would let
    // the removed person enter the epoch it was built for and read what members seal there.
    await controller.removeGroupMember('g-1', 'bob', 'alice', undefined);

    expect(txDeletes).toContainEqual({
      entity: QueuedMessage,
      where: { recipientId: 'bob', groupId: 'g-1', isWelcome: true },
    });
    expect(txDeletes).toContainEqual({
      entity: DeviceGroupMembership,
      where: { userId: 'bob', groupId: 'g-1' },
    });
  });

  it("a removal by ANOTHER member names the removed person's devices as parting, before their rows go", async () => {
    // The commit that removes bob is fanned out from the rows deleted here; without the parting
    // entry it would never reach his devices (second review of #1878, P1-a). Written BEFORE the
    // delete: after it, a crash in between lost the entry and a retry had no rows to derive it from
    // (fourth review).
    await controller.removeGroupMember('g-1', 'bob', 'alice', undefined);

    expect(redis.hset).toHaveBeenCalledWith(
      'group:parting:g-1',
      'bob:b1',
      'alice',
      'bob:b2',
      'alice'
    );
    expect(order).toEqual(['parting-recorded', 'devices-deleted', 'interval-closed']);
  });

  it('a crash rolls the whole removal back, and the entry written before it is still there', async () => {
    failTx = true;

    await expect(controller.removeGroupMember('g-1', 'bob', 'alice', undefined)).rejects.toThrow(
      'serialization failure'
    );
    expect(redis.hset).toHaveBeenCalledWith(
      'group:parting:g-1',
      'bob:b1',
      'alice',
      'bob:b2',
      'alice'
    );
    // The device rows went in the same transaction, so they are back, and a retry writes the same
    // entry again - which is idempotent - before it removes them for good.
    expect(deviceRows.filter((d) => d.userId === 'bob')).toHaveLength(2);
    failTx = false;
    await controller.removeGroupMember('g-1', 'bob', 'alice', undefined);
    expect(deviceRows.filter((d) => d.userId === 'bob')).toHaveLength(0);
  });

  it('a self-leave makes no commit, and names nobody as parting', async () => {
    await controller.removeGroupMember('g-1', 'bob', 'bob', undefined);

    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('counts the window of a person a commit ADMITTED before their enrolment - open-ended until it lands', async () => {
    // dave: removed on the 2nd; the add commit re-admitted his device (a pending row), and his
    // roster row and new interval follow the Welcome. In between he opens every frame of the new
    // epoch, so his window must already be withheld.
    intervals.push({
      userId: 'dave',
      joinedAt: T('2026-10-01T00:00:00Z'),
      leftAt: T('2026-10-02T00:00:00Z'),
    });
    deviceRows.push({ userId: 'dave', deviceId: 'd1' });

    const got = await controller.getGroupExclusions('g-1', 'alice');

    expect(got.exclusions.dave).toEqual([
      { from: T('2026-10-02T00:00:00Z').getTime(), until: null },
    ]);
  });
});
