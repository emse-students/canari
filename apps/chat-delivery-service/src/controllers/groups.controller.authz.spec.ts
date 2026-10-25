/// <reference types="jest" />

import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { FindOperator } from 'typeorm';
import { GroupsController } from './groups.controller';
import { InvitationsController } from './invitations.controller';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';

/**
 * THE GROUP ROUTES ENFORCE MEMBERSHIP: a signed-in caller acts on a group only as an ADMITTED
 * member of it (`assertCallerActsOnGroup`).
 *
 * Each route is driven through the real check over in-memory tables, so what is measured is the
 * answer a caller gets, not that a helper was called: a member succeeds; a stranger, a removed
 * member and anybody asking about an absent or tombstoned group get the SAME 403 `NOT_A_MEMBER`
 * and nothing is written; a seat still awaiting admission gets the 409 its client waits on.
 */

const GROUP = 'g-1';
const MEMBER = 'u-member';
const STRANGER = 'u-stranger';
const WAITING = 'u-waiting';

type Seat = { groupId: string; userId: string; awaitingAdmission: boolean };
type DeviceRow = { groupId: string; userId: string; deviceId: string; status: string };
type GroupRow = {
  id: string;
  distributionWorkspaceId?: string | null;
  distributionChannelId?: string | null;
  deletedAt?: Date | null;
};

/** One `where` clause against an in-memory row, `IsNull()` included (the tombstone filter). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) =>
    v instanceof FindOperator && v.type === 'isNull' ? row[k] == null : row[k] === v
  );
}

/** The three tables the check reads, as plain arrays a test edits. */
function makeTables() {
  const tables = {
    groups: [{ id: GROUP }] as GroupRow[],
    seats: [
      { groupId: GROUP, userId: MEMBER, awaitingAdmission: false },
      { groupId: GROUP, userId: WAITING, awaitingAdmission: true },
    ] as Seat[],
    devices: [] as DeviceRow[],
  };
  const match =
    <T extends Record<string, unknown>>(where: Record<string, unknown>) =>
    (row: T) =>
      matches(row, where);
  const groupRepo = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return tables.groups.find(match<GroupRow>(where)) ?? null;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { transaction: jest.fn() },
  };
  const seatRepo = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const seat = tables.seats.find(match<Seat>(where));
      return seat ? { id: `${seat.groupId}:${seat.userId}`, ...seat } : null;
    }),
  };
  const deviceRepo = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return tables.devices.find(match<DeviceRow>(where)) ?? null;
    }),
  };
  return { tables, groupRepo, seatRepo, deviceRepo };
}

describe('the group routes enforce membership', () => {
  let t: ReturnType<typeof makeTables>;
  let groups: GroupsController;
  let redis: { del: jest.Mock; srem: jest.Mock; smembers: jest.Mock };

  beforeEach(() => {
    t = makeTables();
    redis = { del: jest.fn(), srem: jest.fn(), smembers: jest.fn().mockResolvedValue([]) };
    groups = new GroupsController(
      t.groupRepo as never,
      t.deviceRepo as never,
      t.seatRepo as never,
      {} as never,
      redis as never,
      {} as never
    );
    jest.spyOn(groups['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(groups['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Each route, called as `caller`, and whether it wrote anything. */
  const ROUTES = [
    {
      name: 'rename',
      handler: 'renameGroup',
      call: (c: GroupsController, caller: string) =>
        c.renameGroup(GROUP, { name: 'Nouveau nom' }, caller),
      wrote: () => t.groupRepo.update.mock.calls.length > 0,
    },
    {
      name: 'set the photo',
      handler: 'setGroupImage',
      call: (c: GroupsController, caller: string) =>
        c.setGroupImage(GROUP, { mediaId: 'media-1' }, caller),
      wrote: () => t.groupRepo.update.mock.calls.length > 0,
    },
    {
      name: 'clear the photo',
      handler: 'setGroupImage',
      call: (c: GroupsController, caller: string) =>
        c.setGroupImage(GROUP, { mediaId: null }, caller),
      wrote: () => t.groupRepo.update.mock.calls.length > 0,
    },
    {
      name: 'delete for everyone',
      handler: 'deleteGroup',
      call: (c: GroupsController, caller: string) => c.deleteGroup(GROUP, caller),
      wrote: () => t.groupRepo.manager.transaction.mock.calls.length > 0,
    },
  ];

  describe.each(ROUTES)('$name', ({ handler, call, wrote }) => {
    it('is carried out for an admitted member', async () => {
      // The delete's sweep is measured by `groupEnds.onePolicy.spec.ts`; here it only has to run.
      t.groupRepo.manager.transaction.mockResolvedValue({});

      await expect(call(groups, MEMBER)).resolves.toBeDefined();
      expect(wrote()).toBe(true);
    });

    it('refuses a signed-in stranger with the 403 NOT_A_MEMBER, and writes nothing', async () => {
      const refusal = await call(groups, STRANGER).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'NOT_A_MEMBER' });
      expect(wrote()).toBe(false);
    });

    it('refuses a removed member exactly as a stranger', async () => {
      t.tables.seats = t.tables.seats.filter((s) => s.userId !== MEMBER);

      await expect(call(groups, MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(wrote()).toBe(false);
    });

    it('answers a seat awaiting admission the 409 it waits on, never the 403 that retires', async () => {
      await expect(call(groups, WAITING)).rejects.toBeInstanceOf(ConflictException);
      expect(wrote()).toBe(false);
    });

    it('answers an absent group the same 403 as a stranger, so the route names no ids', async () => {
      t.tables.groups = [];

      await expect(call(groups, MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(wrote()).toBe(false);
    });

    it('answers a tombstoned group that still holds a seat the same 403, and writes nothing', async () => {
      // The tombstone is read from `deletedAt` itself, not inferred from a purge having run.
      t.tables.groups = [{ id: GROUP, deletedAt: new Date() }];

      const refusal = await call(groups, MEMBER).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'NOT_A_MEMBER' });
      expect(wrote()).toBe(false);
    });

    it('refuses a key-distribution group to its own admitted member, and writes nothing', async () => {
      t.tables.groups = [{ id: GROUP, distributionWorkspaceId: 'ws-1' }];
      t.tables.seats = [];
      t.tables.devices = [{ groupId: GROUP, userId: MEMBER, deviceId: 'd-1', status: 'active' }];

      const refusal = await call(groups, MEMBER).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: 'KEY_DISTRIBUTION_GROUP',
      });
      expect(wrote()).toBe(false);
    });

    it('answers a stranger to a key-distribution group NOT_A_MEMBER, naming nothing of its kind', async () => {
      t.tables.groups = [{ id: GROUP, distributionChannelId: 'ch-1' }];
      t.tables.seats = [];
      t.tables.devices = [{ groupId: GROUP, userId: MEMBER, deviceId: 'd-1', status: 'active' }];

      const refusal = await call(groups, STRANGER).catch((e: unknown) => e);

      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'NOT_A_MEMBER' });
      expect(wrote()).toBe(false);
    });

    it('is still refused by the authentication guard before any of this', () => {
      const method = (GroupsController.prototype as unknown as Record<string, object>)[handler];
      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toContain(HeaderAuthGuard);
    });
  });

  it('a replayed delete of a group already ended is the 403 the owed exit reads as done', async () => {
    // The tombstone purges every seat, the deleter's included. The client's replay of an exit it
    // still owes (`pendingGroupExits`) counts 403 and 404 as "already gone" and stops owing it.
    t.tables.groups = [{ id: GROUP }];
    t.tables.seats = [];

    const refusal = await groups.deleteGroup(GROUP, MEMBER).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getStatus()).toBe(403);
    expect(t.groupRepo.manager.transaction).not.toHaveBeenCalled();
  });

  it('a key-distribution group is never deleted for everyone here, whoever asks', async () => {
    t.tables.groups = [{ id: GROUP, distributionWorkspaceId: 'ws-1' }];
    t.tables.devices = [{ groupId: GROUP, userId: MEMBER, deviceId: 'd-1', status: 'active' }];

    for (const caller of [MEMBER, STRANGER, WAITING]) {
      await expect(groups.deleteGroup(GROUP, caller)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(t.groupRepo.manager.transaction).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('a group that is no key-distribution group keeps "any admitted member" for all three routes', async () => {
    t.groupRepo.manager.transaction.mockResolvedValue({});

    await expect(groups.renameGroup(GROUP, { name: 'x' }, MEMBER)).resolves.toEqual({
      status: 'renamed',
    });
    await expect(groups.setGroupImage(GROUP, { mediaId: null }, MEMBER)).resolves.toBeDefined();
    await expect(groups.deleteGroup(GROUP, MEMBER)).resolves.toBeDefined();
  });

  it('an unauthenticated call never reaches a route: the guard answers 401', () => {
    const request = { headers: {}, url: '/mls/groups/g-1', method: 'DELETE' };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    expect(() => new HeaderAuthGuard().canActivate(context)).toThrow(UnauthorizedException);
  });
});

describe('the device-membership deletions enforce who may end a row', () => {
  let t: ReturnType<typeof makeTables>;
  let invitations: InvitationsController;
  let transaction: jest.Mock;
  /** The device rows the transaction deleted, read off the same in-memory table. */
  let deleted: DeviceRow[];
  /** Whether the transaction's status read took a row lock. */
  let lockedRead: unknown;

  beforeEach(() => {
    t = makeTables();
    deleted = [];
    lockedRead = undefined;
    transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({
        getRepository: (entity: unknown) => ({
          findOne: jest.fn(
            async ({ where, lock }: { where: Record<string, unknown>; lock?: unknown }) => {
              lockedRead = lock;
              return t.tables.devices.find((r) => matches(r, where)) ?? null;
            }
          ),
          delete: jest.fn(async (where: Record<string, unknown>) => {
            if (entity !== DeviceGroupMembership) return { affected: 0 };
            const gone = t.tables.devices.filter((r) => matches(r, where));
            deleted.push(...gone);
            t.tables.devices = t.tables.devices.filter((r) => !matches(r, where));
            return { affected: gone.length };
          }),
        }),
      })
    );
    const deviceGroupRepo = {
      ...t.deviceRepo,
      find: jest.fn().mockResolvedValue([]),
      manager: { transaction },
    };
    invitations = new InvitationsController(
      deviceGroupRepo as never,
      t.seatRepo as never,
      t.groupRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { srem: jest.fn().mockResolvedValue(1) } as never,
      {} as never
    );
    jest.spyOn(invitations['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(invitations['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("lets a person end their own device's row in a group", async () => {
    await expect(
      invitations.deleteDeviceMembership(STRANGER, 'd-1', GROUP, STRANGER)
    ).resolves.toMatchObject({ status: 'deleted' });
  });

  it('lets a person end their own ACTIVE device row in a group', async () => {
    t.tables.devices = [{ groupId: GROUP, userId: MEMBER, deviceId: 'd-1', status: 'active' }];

    await expect(
      invitations.deleteDeviceMembership(MEMBER, 'd-1', GROUP, MEMBER)
    ).resolves.toMatchObject({ status: 'deleted', affected: 1 });
    expect(deleted).toHaveLength(1);
  });

  it("lets an admitted member end another person's PENDING device row in that group", async () => {
    t.tables.devices = [{ groupId: GROUP, userId: STRANGER, deviceId: 'd-1', status: 'pending' }];

    await expect(
      invitations.deleteDeviceMembership(STRANGER, 'd-1', GROUP, MEMBER)
    ).resolves.toMatchObject({ status: 'deleted', affected: 1 });
    expect(deleted).toEqual([expect.objectContaining({ userId: STRANGER, status: 'pending' })]);
    expect(lockedRead).toEqual({ mode: 'pessimistic_write' });
  });

  it("refuses an admitted member ending another member's ACTIVE device row, and ends nothing", async () => {
    t.tables.devices = [{ groupId: GROUP, userId: WAITING, deviceId: 'd-2', status: 'active' }];

    const refusal = await invitations
      .deleteDeviceMembership(WAITING, 'd-2', GROUP, MEMBER)
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: 'MEMBERSHIP_NOT_ALLOWED',
    });
    expect(deleted).toEqual([]);
    expect(t.tables.devices).toHaveLength(1);
  });

  it("refuses a stranger ending somebody else's device row, and ends nothing", async () => {
    await expect(
      invitations.deleteDeviceMembership(MEMBER, 'd-1', GROUP, STRANGER)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses ending every row of another person's device, and ends nothing", async () => {
    await expect(
      invitations.deleteAllDeviceMemberships(MEMBER, 'd-1', STRANGER)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('lets a person end every row of their own device', async () => {
    await expect(
      invitations.deleteAllDeviceMemberships(MEMBER, 'd-1', MEMBER)
    ).resolves.toMatchObject({ status: 'deleted' });
  });
});
