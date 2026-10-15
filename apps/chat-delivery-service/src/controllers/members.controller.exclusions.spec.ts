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
  let deviceRows: Array<{ userId: string; deviceId: string }>;
  let order: string[];
  let failTx: boolean;
  let redis: { smembers: jest.Mock; srem: jest.Mock; hset: jest.Mock };

  const T = (iso: string) => new Date(iso);

  beforeEach(async () => {
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
      // The real insert lands in the table the next read comes from.
      execute: () => {
        intervals.push(
          ...healInserts.map(({ userId, joinedAt, leftAt }) => ({ userId, joinedAt, leftAt }))
        );
        return Promise.resolve({ identifiers: [] });
      },
    };
    const dataSource = {
      manager: { find: intervalFind, createQueryBuilder: () => healBuilder },
      transaction: (fn: (m: unknown) => Promise<unknown>) => fn(txManager),
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
        { provide: getRepositoryToken(Group), useValue: {} },
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
            // The exclusions read: DISTINCT users holding a device row, whatever its status.
            createQueryBuilder: () => {
              const qb = {
                select: () => qb,
                distinct: () => qb,
                where: () => qb,
                getRawMany: async () =>
                  [...new Set(deviceRows.map((d) => d.userId))].map((userId) => ({ userId })),
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

    // bob's gap, and nobody else: alice never left, carol arrived late (no window before a first
    // arrival - a late joiner keeps the existing policy).
    expect(got.exclusions).toEqual({
      bob: [
        { from: T('2026-10-03T00:00:00Z').getTime(), until: T('2026-10-05T00:00:00Z').getTime() },
      ],
    });
    expect(intervalFind).toHaveBeenCalledWith(GroupMembershipInterval, expect.anything());
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

    expect(txDeletes).toEqual([{ entity: GroupMember, where: { groupId: 'g-1', userId: 'bob' } }]);
    expect(txUpdates).toHaveLength(1);
    expect(txUpdates[0].entity).toBe(GroupMembershipInterval);
    expect(txUpdates[0].where).toMatchObject({ groupId: 'g-1', userId: 'bob' });
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

  it('a crash after the device rows went still leaves the entry - a retry could not re-derive it', async () => {
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
    // The retry finds no device rows to derive an entry from - which is why it was written first.
    redis.hset.mockClear();
    failTx = false;
    await controller.removeGroupMember('g-1', 'bob', 'alice', undefined);
    expect(redis.hset).not.toHaveBeenCalled();
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
