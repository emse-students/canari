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
    intervalFind = jest.fn(() => Promise.resolve(intervals));

    const txManager = {
      getRepository: (entity: unknown) => ({
        delete: (where: unknown) => {
          txDeletes.push({ entity, where });
          return Promise.resolve({ affected: 1 });
        },
        update: (where: Record<string, unknown>) => {
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
          useValue: { delete: jest.fn().mockResolvedValue({ affected: 2 }) },
        },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: {} },
        {
          provide: 'REDIS_CLIENT',
          useValue: { smembers: jest.fn().mockResolvedValue([]), srem: jest.fn() },
        },
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
});
