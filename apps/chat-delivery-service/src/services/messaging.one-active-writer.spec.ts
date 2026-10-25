/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { GroupsController } from '../controllers/groups.controller';
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
import { isEntitledToDistributionGroup } from '../internal/distribution-entitlement';

// social-service's entitlement answer, which a report in a key-distribution group asks.
jest.mock('../internal/distribution-entitlement', () => ({
  ...jest.requireActual('../internal/distribution-entitlement'),
  isEntitledToDistributionGroup: jest.fn(),
}));
const entitled = isEntitledToDistributionGroup as jest.MockedFunction<
  typeof isEntitledToDistributionGroup
>;

/**
 * ONE WRITER FOR `pending -> active`, ASSERTED AS ONE WRITER AND AS THREE DOORS.
 *
 * The entity docblock has said, in bold, that `activateDeviceMembership` is the only thing that
 * writes `active` and the only writer of the Redis routing set. It was not true. Three paths made
 * that transition and agreed on nothing:
 *
 * | Path | Addressability gate | Redis routing set | `kickedAt` | Missed-message replay |
 * | --- | --- | --- | --- | --- |
 * | `activateDeviceMembership` | warn and return | written | cleared | yes |
 * | `updateInvitationStatus` | THROW | **never written** | cleared | **no** |
 * | `createGroup` | **none at all** | written | left unset | n/a |
 *
 * The middle row is the one that cost something. A device that processed its Welcome in the
 * FOREGROUND got a truthful `active` row and was never added to `group:members:{groupId}`, so the
 * gateway could not reach it and could not elect it to answer a `welcome_request` or a
 * `history_request` - silently, because an INCOMPLETE routing set is not an empty one and the
 * reload at each election door only fires on an EMPTY set.
 *
 * The third row is WP-GHOST-1 with no gate at all, plus the 2026-08-27 placeholder defect: group
 * creation stored whatever identity it was handed, including the client's unresolved-identity
 * placeholder that the status endpoint was hardened against.
 *
 * **The decomposition, deliberately.** The one writer's OWN behaviour is asserted against a real
 * `MessagingService`; each door is asserted to DELEGATE to it. That is the fusion's actual claim -
 * "there is one implementation and every door reaches it" - and asserting the routing-set write
 * again at each door would re-pin the duplication this deletes.
 */
describe('the ONE writer of an active membership', () => {
  let service: MessagingService;
  /** The writer's mechanics, under an authority that creates its seat (group creation). */
  const CREATOR = { authority: 'group_creator' as const };
  let warn: jest.SpyInstance;

  const redis = {
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    xrange: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1),
  };
  const revokedDeviceRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const keyPackageRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'kp-1' }),
    // The key package as a seat writer re-reads it under the lock, before it inserts.
    find: jest.fn().mockResolvedValue([{ userId: 'u1', deviceId: 'd1' }]),
  };
  const deviceGroupRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });
  const groupRepo: ReturnType<typeof emptyRepo> & { manager?: unknown } = emptyRepo();
  const groupMemberRepo = emptyRepo();

  beforeEach(async () => {
    jest.clearAllMocks();
    // The seat lock's transaction: the lock statement answers nothing, the seat table is the
    // in-memory one below - so a write and the route's re-read see the same rows.
    groupRepo.manager = {
      // The seat claim's read (`claimSeat`): generation 0, no departure in progress.
      query: async () => [],
      transaction: async (cb: (m: unknown) => Promise<unknown>) =>
        cb({
          query: async () => [],
          getRepository: (entity: unknown) =>
            entity === KeyPackage
              ? keyPackageRepo
              : entity === RevokedDevice
                ? revokedDeviceRepo
                : deviceGroupRepo,
        }),
    };
    groupRepo.findOne.mockResolvedValue(null);
    groupMemberRepo.findOne.mockResolvedValue(null);
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    keyPackageRepo.findOne.mockResolvedValue({ id: 'kp-1' });
    keyPackageRepo.find.mockResolvedValue([{ userId: 'u1', deviceId: 'd1' }]);
    deviceGroupRepo.findOne.mockResolvedValue(null);
    redis.xrange.mockResolvedValue([]);
    entitled.mockReset();
    entitled.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    const logger = (service as unknown as { logger: { warn: (m: string) => void } }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest
      .spyOn(logger as unknown as { log: (m: string) => void }, 'log')
      .mockImplementation(() => {});
  });

  it('writes the row AND the routing set - the two facts a reachable device needs', async () => {
    // The route is written after the seat's commit, against the seat re-read under the lock.
    deviceGroupRepo.findOne.mockResolvedValue({ deviceId: 'd1' });
    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(outcome.ok).toBe(true);
    expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', deviceId: 'd1', groupId: 'g1', status: 'active' }),
      expect.anything()
    );
    expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
  });

  it('clears `kickedAt`: the device is IN, so no Add is outstanding', async () => {
    await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ kickedAt: null }),
      expect.anything()
    );
  });

  it('clears `admittedAtEpoch`: the status routes the device from here on', async () => {
    await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ admittedAtEpoch: null }),
      expect.anything()
    );
  });

  it('refuses a REVOKED device and writes neither the row nor the set (WP-GHOST-1)', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ userId: 'u1', deviceId: 'd1' });

    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(outcome).toEqual({ ok: false, reason: 'revoked' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });

  it('refuses a device with NO KeyPackage - one good enough to be messaged is one good enough to be invited', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(outcome).toEqual({ ok: false, reason: 'no_key_package' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses a creator's seat whose key package is gone by the time the seat lock is held", async () => {
    // Addressable at the gate; an account erasure deleted the key package before the write.
    keyPackageRepo.find.mockResolvedValue([]);

    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(outcome).toEqual({ ok: false, reason: 'no_key_package' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });

  it('ACCUSES under the CALLER tag, so a refusal names the door that asked', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ userId: 'u1', deviceId: 'd1' });

    await service.activateDeviceMembership('u1', 'd1', 'g1', { tag: 'CREATE_GROUP', ...CREATOR });

    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REFUSED'));
    expect(line).toBeDefined();
    expect(line).toContain('CREATE_GROUP');
    expect(line).toContain('revoked');
  });

  it('logs the refusal even when the caller ignores the returned reason', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    // The return value is dropped on purpose: a best-effort seam may do exactly this, and the
    // record must survive it.
    await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('REFUSED');
  });

  // TWO OF THE FOUR DOORS DID NOT SANITIZE THE IDENTITY, so the check is here, where there is one
  // of it. `deviceAddressability` cannot answer this question: a placeholder that registered a
  // KeyPackage is addressable, which is precisely how `userId='unknown'`, `deviceId='pending'`
  // became an ACTIVE member of a real conversation on 2026-08-27.
  it.each([
    ['userId', 'unknown', 'd1'],
    ['deviceId', 'u1', 'pending'],
  ])("refuses the client's unresolved-identity placeholder in %s", async (field, u, d) => {
    const outcome = await service.activateDeviceMembership(u, d, 'g1', CREATOR);

    expect(outcome).toEqual({ ok: false, reason: 'unresolved_identity' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();

    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REFUSED'));
    expect(line).toContain('unresolved_identity');
    expect(line).toContain(`field=${field}`);
  });

  // It is refused BEFORE the addressability gate, and the gate is why: that gate is a database
  // round trip asking whether a device is reachable, and a value that names no device has no
  // answer there worth spending. A typed reason rather than a message, because nothing in this
  // codebase branches on prose.
  it('refuses the placeholder without asking the database whether it is addressable', async () => {
    await service.activateDeviceMembership('unknown', 'pending', 'g1', CREATOR);

    expect(revokedDeviceRepo.findOne).not.toHaveBeenCalled();
    expect(keyPackageRepo.findOne).not.toHaveBeenCalled();
  });

  it('replays nothing, whatever the prior state - an admitted device was queued at send time', async () => {
    // DF2 is deleted (user, 2026-09-28): what a pending device can open reaches it through the
    // admission its commit recorded, never through a window read back here.
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending', createdAt: new Date() });

    await service.activateDeviceMembership('u1', 'd1', 'g1', CREATOR);

    expect(redis.xrange).not.toHaveBeenCalled();
  });

  /**
   * A REPORT PROMOTES A SEAT AND NEVER CREATES ONE - checked HERE, in the one writer, so neither
   * reporting door (`invitations/status`, `push/membership-active`) can skip it. The seat table is
   * in memory and answers by `where`, so a lookup on the wrong columns finds nothing.
   */
  describe('a report', () => {
    type Seat = {
      userId: string;
      deviceId: string;
      groupId: string;
      status: 'pending' | 'active';
      kickedAt?: Date | null;
      admittedAtEpoch?: number | null;
    };
    let seats: Seat[];
    let roster: Array<{ groupId: string; userId: string }>;
    let groupRow: Record<string, unknown> | null;
    /** Runs at the instant the UPDATE executes - a concurrent writer landing before it. */
    let racing: (() => void) | null;
    /** Every clause the UPDATE was built with, so its guards are asserted as SQL too. */
    let clauses: string[];
    const REPORT = { authority: 'report' as const, tag: 'INVITATION_STATUS' };
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => row[k] === v);

    beforeEach(() => {
      seats = [{ userId: 'u1', deviceId: 'd1', groupId: 'g1', status: 'pending', kickedAt: null }];
      roster = [{ groupId: 'g1', userId: 'u1' }];
      groupRow = { id: 'g1' };
      racing = null;
      clauses = [];
      groupRepo.findOne.mockImplementation(async () => groupRow);
      // THE CONDITIONAL UPDATE, evaluated against the tables as they stand WHEN IT RUNS: the row by
      // its triple, active or unkicked, in a key group or with its owner on the roster. It never
      // inserts. The guards are also asserted as SQL below, so the two cannot drift apart silently.
      deviceGroupRepo.createQueryBuilder.mockImplementation(() => {
        let params: Record<string, unknown> = {};
        let values: Partial<Seat> = {};
        const mine: string[] = [];
        const qb = {
          update: () => qb,
          set: (v: Partial<Seat>) => ((values = v), qb),
          where: (c: string, p: Record<string, unknown>) => (
            clauses.push(c),
            mine.push(c),
            (params = p),
            qb
          ),
          andWhere: (c: string) => (clauses.push(c), mine.push(c), qb),
          execute: async () => {
            racing?.();
            // The guards this statement was BUILT with: a pending row only where an unkicked one is
            // allowed, and the roster only where it is required.
            const sql = mine.join(' ');
            const pendingAllowed = sql.includes('"kickedAt" IS NULL');
            const rosterRequired = sql.includes('dm_group_members');
            const row = seats.find(
              (r) =>
                matches(r, params) &&
                (r.status === 'active' || (pendingAllowed && !r.kickedAt)) &&
                (!rosterRequired ||
                  roster.some((m) => matches(m, { groupId: r.groupId, userId: r.userId })))
            );
            if (row) Object.assign(row, values);
            return { affected: row ? 1 : 0 };
          },
        };
        return qb;
      });
      deviceGroupRepo.findOne.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          seats.find((r) => matches(r, where)) ?? null
      );
      // A demotion's UPDATE: the rows its criteria match, never an insert.
      deviceGroupRepo.update.mockImplementation(
        async (where: Record<string, unknown>, values: Partial<Seat>) => {
          const hit = seats.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, values));
          return { affected: hit.length };
        }
      );
      // The table's unique key is (deviceId, groupId): an upsert merges into that row.
      deviceGroupRepo.upsert.mockImplementation(async (row: Seat) => {
        const i = seats.findIndex((r) => r.deviceId === row.deviceId && r.groupId === row.groupId);
        if (i < 0) seats.push({ ...row });
        else seats[i] = { ...seats[i], ...row };
      });
      groupMemberRepo.findOne.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          roster.find((r) => matches(r, where)) ?? null
      );
    });

    it('promotes the pending seat its admission wrote, in one UPDATE by the triple', async () => {
      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: true,
      });
      expect(seats[0]).toMatchObject({ status: 'active', kickedAt: null });
      expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
      // NO INSERT PATH: a report never upserts.
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
      const sql = clauses.join(' ');
      expect(sql).toContain(
        '"userId" = :userId AND "deviceId" = :deviceId AND "groupId" = :groupId'
      );
      expect(sql).toContain(`(status = 'active' OR "kickedAt" IS NULL)`);
      expect(sql).toContain('dm_group_members');
      // A conversation's membership is its roster: social-service is not asked.
      expect(entitled).not.toHaveBeenCalled();
    });

    it('does not re-create a row a removal deleted between any read and the write', async () => {
      // The removal lands at the instant the UPDATE runs: the statement matches nothing, and
      // nothing is inserted or routed - a read-then-upsert re-created the active row here.
      racing = () => (seats = []);

      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: false,
        reason: 'no_seat',
      });
      expect(seats).toEqual([]);
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
      expect(redis.sadd).not.toHaveBeenCalled();
    });

    it('does not clear a kick that lands between any read and the write', async () => {
      racing = () => (seats[0].kickedAt = new Date('2026-10-22T10:00:00Z'));

      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: false,
        reason: 'kicked',
      });
      expect(seats[0]).toMatchObject({ status: 'pending' });
      expect(seats[0].kickedAt).toBeInstanceOf(Date);
      expect(redis.sadd).not.toHaveBeenCalled();
    });

    it('is idempotent on a seat an accepted external commit already made active', async () => {
      seats[0].status = 'active';

      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: true,
      });
    });

    it.each([
      ['no seat at all', () => (seats = []), 'no_seat'],
      [
        "only ANOTHER account's seat for this device id",
        () => (seats[0].userId = 'u-other'),
        'no_seat',
      ],
      ['a kick no admitting commit has answered', () => (seats[0].kickedAt = new Date()), 'kicked'],
      ['an owner no longer on the roster', () => (roster = []), 'not_on_roster'],
    ])('refuses %s, and writes neither the row nor the set', async (_name, arrange, reason) => {
      arrange();
      const before = JSON.stringify(seats);

      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(JSON.stringify(seats)).toBe(before);
      expect(redis.sadd).not.toHaveBeenCalled();
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REFUSED'));
      expect(line).toContain('INVITATION_STATUS');
      expect(line).toContain(`reason=${reason}`);
    });

    describe('in a key-distribution group, which has no user roster here', () => {
      beforeEach(() => {
        groupRow = { id: 'g1', distributionWorkspaceId: 'ws-1' };
        roster = [];
      });

      it('promotes a pending seat once social-service answers that its owner is entitled', async () => {
        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: true,
        });
        expect(entitled).toHaveBeenCalledWith(
          { kind: 'workspace', id: 'ws-1' },
          'u1',
          expect.any(String)
        );
        expect(seats[0]).toMatchObject({ status: 'active' });
        expect(clauses.join(' ')).not.toContain('dm_group_members');
      });

      it('refuses a pending seat whose owner is not entitled, and writes neither the row nor the set', async () => {
        entitled.mockResolvedValue(false);

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: false,
          reason: 'not_entitled',
        });
        expect(seats[0]).toMatchObject({ status: 'pending' });
        expect(redis.sadd).not.toHaveBeenCalled();
        expect(deviceGroupRepo.createQueryBuilder).not.toHaveBeenCalled();
        const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REFUSED'));
        expect(line).toContain('INVITATION_STATUS');
        expect(line).toContain('reason=not_entitled');
      });

      it('re-reports an active seat without asking anyone, and promotes no pending one that way', async () => {
        seats[0].status = 'active';

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: true,
        });
        expect(entitled).not.toHaveBeenCalled();
        // Unasked, the statement may match an active seat only.
        expect(clauses.join(' ')).toContain(`status = 'active'`);
        expect(clauses.join(' ')).not.toContain('"kickedAt" IS NULL');
      });

      it('promotes nothing when a departure overtook the claim the entitlement was asked against', async () => {
        // The departure begins while social-service is answering: the claim re-read under the
        // seat lock finds it in progress.
        (groupRepo as unknown as { manager: unknown }).manager = {
          query: async () => [],
          transaction: async (cb: (m: unknown) => Promise<unknown>) =>
            cb({
              query: async (sql: string) =>
                sql.includes('FROM dm_seat_evictions') ? [{ generation: 0, owedDeparture: 1 }] : [],
              getRepository: () => deviceGroupRepo,
            }),
        };

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: false,
          reason: 'departed',
        });
        expect(seats[0]).toMatchObject({ status: 'pending' });
        expect(redis.sadd).not.toHaveBeenCalled();
      });

      it("promotes when only SOMEONE ELSE's eviction moved the group's generation meanwhile", async () => {
        // A report has no retry: the generation is the group's, so it must not refuse here. An
        // eviction of THIS person would have deleted the row the statement updates.
        (groupRepo as unknown as { manager: unknown }).manager = {
          query: async () => [],
          transaction: async (cb: (m: unknown) => Promise<unknown>) =>
            cb({
              query: async (sql: string) =>
                sql.includes('FROM dm_seat_evictions')
                  ? [{ generation: 7, owedDeparture: null }]
                  : [],
              getRepository: () => deviceGroupRepo,
            }),
        };

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: true,
        });
        expect(seats[0]).toMatchObject({ status: 'active' });
      });

      it('refuses a departure already in progress without asking social-service', async () => {
        (groupRepo as unknown as { manager: { query: unknown } }).manager.query = async () => [
          { generation: 1, owedDeparture: 1 },
        ];

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
          ok: false,
          reason: 'departed',
        });
        expect(entitled).not.toHaveBeenCalled();
        expect(seats[0]).toMatchObject({ status: 'pending' });
      });

      it('lets an unanswered entitlement fail the report whole, promoting nothing', async () => {
        entitled.mockRejectedValue(new Error('503'));

        await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).rejects.toThrow(
          '503'
        );
        expect(seats[0]).toMatchObject({ status: 'pending' });
      });
    });

    /**
     * The seat lock's transaction: `query` answers the claim re-read (the group's generation and the
     * departure in progress) and records the lock taken, `getRepository` hands back the seat table.
     */
    const lockedManager = (
      eviction: { generation: number; owedDeparture: number | null } | null
    ) => {
      const locks: string[] = [];
      (groupRepo as unknown as { manager: unknown }).manager = {
        query: async () => [],
        transaction: async (cb: (m: unknown) => Promise<unknown>) =>
          cb({
            query: async (sql: string, params: unknown[]) => {
              if (sql.includes('pg_advisory_xact_lock')) locks.push(String(params[0]));
              return sql.includes('FROM dm_seat_evictions') && eviction ? [eviction] : [];
            },
            getRepository: (entity: unknown) =>
              entity === KeyPackage
                ? keyPackageRepo
                : entity === RevokedDevice
                  ? revokedDeviceRepo
                  : deviceGroupRepo,
          }),
      };
      return locks;
    };
    const claim = { groupId: 'g1', userId: 'u1', generation: 0, owed: false };

    it('lets every other authority create the seat it is the gate for', async () => {
      seats = [];
      const locks = lockedManager(null);

      await expect(
        service.activateDeviceMembership('u1', 'd1', 'g1', { authority: 'group_creator' })
      ).resolves.toEqual({ ok: true });
      for (const authority of ['accepted_commit', 'distribution_publisher'] as const) {
        await expect(
          service.activateDeviceMembership('u1', 'd1', 'g1', { authority, claim })
        ).resolves.toEqual({ ok: true });
      }
      expect(seats).toHaveLength(1);
      // Every write takes it - the creator's too, which inserts beside its key package like the
      // others - and each of the three routes takes it again after its seat committed.
      expect(locks).toEqual(Array(6).fill('seat:g1'));
      expect(redis.sadd).toHaveBeenCalledTimes(3);
    });

    it('writes no route for a promoted seat an eviction deleted after its commit', async () => {
      // The eviction lands between the promotion's commit and the route's re-read under the lock.
      const transaction = (
        groupRepo.manager as { transaction: (cb: (m: unknown) => Promise<unknown>) => unknown }
      ).transaction;
      let calls = 0;
      (groupRepo as unknown as { manager: unknown }).manager = {
        query: async () => [],
        transaction: async (cb: (m: unknown) => Promise<unknown>) => {
          if (++calls === 2) seats = [];
          return transaction(cb);
        },
      };

      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: true,
      });
      expect(seats).toEqual([]);
      expect(redis.sadd).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('route NOT written');
    });

    it('promotes a reported seat under the group seat lock', async () => {
      const locks = lockedManager(null);

      await service.activateDeviceMembership('u1', 'd1', 'g1', REPORT);

      // The promotion, then the route after it committed.
      expect(locks).toEqual(['seat:g1', 'seat:g1']);
    });

    it('writes no seat against a claim an eviction overtook, or a departure in progress', async () => {
      seats = [];
      lockedManager({ generation: 1, owedDeparture: null });
      await expect(
        service.activateDeviceMembership('u1', 'd1', 'g1', { authority: 'accepted_commit', claim })
      ).resolves.toEqual({ ok: false, reason: 'departed' });

      lockedManager({ generation: 0, owedDeparture: 1 });
      await expect(
        service.activateDeviceMembership('u1', 'd1', 'g1', {
          authority: 'distribution_publisher',
          claim,
        })
      ).resolves.toEqual({ ok: false, reason: 'departed' });
      expect(seats).toHaveLength(0);
    });

    it('refuses a claimed authority that brought no claim, rather than writing an unguarded seat', async () => {
      seats = [];
      lockedManager(null);
      await expect(
        service.activateDeviceMembership('u1', 'd1', 'g1', { authority: 'accepted_commit' })
      ).resolves.toEqual({ ok: false, reason: 'departed' });
      expect(seats).toHaveLength(0);
    });

    it('follows kick-and-re-add end to end: kicked, admitted, then reported', async () => {
      seats[0].status = 'active';
      // 1. A member removes the device's stale leaf and records the kick.
      await service.deactivateDeviceMembership('u1', 'd1', 'g1', {
        removedFromTreeAt: new Date('2026-10-22T10:00:00Z'),
        tag: 'KICK_DEVICE',
      });
      expect(seats[0]).toMatchObject({ status: 'pending' });
      expect(seats[0].kickedAt).toBeInstanceOf(Date);

      // 2. Before any Add answers it, the device's own report is refused: the kick stands.
      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: false,
        reason: 'kicked',
      });

      // 3. The member's accepted commit ADMITS the device - the update `validateCommit` makes, by
      //    the pair and guarded on `pending` (asserted on its own in messaging.commit-log.spec.ts).
      //    The Welcome that follows never touches the row (messaging.welcome-membership.spec.ts).
      const admitted = seats.find((r) =>
        matches(r, { userId: 'u1', deviceId: 'd1', groupId: 'g1', status: 'pending' })
      );
      Object.assign(admitted as Seat, { admittedAtEpoch: 6, kickedAt: null });

      // 4. The device processes its Welcome and reports: promoted.
      await expect(service.activateDeviceMembership('u1', 'd1', 'g1', REPORT)).resolves.toEqual({
        ok: true,
      });
      expect(seats[0]).toMatchObject({ status: 'active', kickedAt: null });
      expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
    });
  });
});

describe('the INVITATION_STATUS door', () => {
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
    messaging.activateDeviceMembership.mockResolvedValue({ ok: true });
    // The device holds a `pending` seat and its owner is on the roster: a report promotes a seat,
    // it never creates one (`invitations.controller.vouch.spec.ts`).
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending' });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        {
          provide: getRepositoryToken(GroupMember),
          useValue: { ...emptyRepo(), findOne: jest.fn().mockResolvedValue({ userId: 'u1' }) },
        },
        {
          provide: getRepositoryToken(Group),
          useValue: { ...emptyRepo(), findOne: jest.fn().mockResolvedValue({ id: 'g1' }) },
        },
        { provide: getRepositoryToken(GroupInvite), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: { srem: jest.fn(), mget: jest.fn() } },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InvitationsController);
  });

  const promote = () =>
    controller.updateInvitationStatus(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'active' },
      'u1',
      'false'
    );

  it('promotes through the one writer instead of writing the row itself', async () => {
    const answer = await promote();

    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      'g1',
      expect.objectContaining({ tag: 'INVITATION_STATUS' })
    );
    // The local save is what left the routing set unwritten for a year; it must be gone.
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
    expect(answer).toEqual({ status: 'active' });
  });

  it('still THROWS on a refusal - this door has a user to tell', async () => {
    messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(promote()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does NOT reach the promotion writer on a demotion - the two directions are separate', async () => {
    await controller.updateInvitationStatus(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'pending' },
      'u1',
      'false'
    );

    // What the demotion DOES is the sibling suite's subject: it was written locally here until
    // 2026-09-13, and called no `srem`, so it left the device routable. It now goes through
    // `deactivateDeviceMembership`, and `messaging.one-pending-writer.spec.ts` asserts that.
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
  });
});

describe('the CREATE_GROUP door', () => {
  let controller: GroupsController;
  const messaging = {
    activateDeviceMembership: jest.fn().mockResolvedValue({ ok: true }),
    deviceAddressability: jest.fn().mockResolvedValue({ ok: true }),
  };
  const groupRepo = {
    create: jest.fn().mockImplementation((e: unknown) => e),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    findOne: jest.fn().mockResolvedValue(null),
    // The undo. A creation that writes the row and then fails to enrol its creator used to leave a
    // member-less group nothing anywhere collects - measured on production 2026-09-14, population 1.
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const BODY = { name: 'Amis', createdBy: 'u1', creatorDeviceId: 'd1' };

  beforeEach(async () => {
    jest.clearAllMocks();
    messaging.activateDeviceMembership.mockResolvedValue({ ok: true });
    messaging.deviceAddressability.mockResolvedValue({ ok: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: { findOne: jest.fn() } },
        { provide: 'REDIS_CLIENT', useValue: { sadd: jest.fn() } },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(GroupsController);
  });

  it('enrols the creator through the one writer, with no replay to a group made this instant', async () => {
    await controller.createGroup(BODY);

    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      expect.any(String),
      expect.objectContaining({ tag: 'CREATE_GROUP' })
    );
  });

  it('REFUSES an unaddressable creator - the door that used to ask nothing', async () => {
    messaging.deviceAddressability.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes NO group row when it refuses, so a 400 leaves no orphan behind', async () => {
    messaging.deviceAddressability.mockResolvedValue({ ok: false, reason: 'no_key_package' });

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);
    expect(groupRepo.save).not.toHaveBeenCalled();
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });

  /**
   * THE ASSERTION ABOVE STOPPED EXACTLY WHERE THE HOLE STARTED. It covers the refusal BEFORE the
   * row is written, which is the one the route was designed around. Two ways to fail AFTER it had
   * no test at all, and both leave a `dm_groups` row with no members, no commits, no published base
   * and no queued frames.
   *
   * **Nothing collects that row.** `findOrphanGroupIds` asks which groups still own rows while
   * their `dm_groups` row is GONE - the mirror of this case, and blind to it. So it is permanent,
   * and it counts as a live group in every query that counts them: this is how the one on
   * production was reported on 2026-09-12 as "a group nobody can repair", when in fact nobody was
   * ever in it.
   */
  it('discards the row when the enrolment REFUSES after it was written', async () => {
    messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);

    expect(groupRepo.save).toHaveBeenCalled();
    expect(groupRepo.delete).toHaveBeenCalledWith({
      id: (groupRepo.save.mock.calls[0][0] as { id: string }).id,
    });
  });

  it('discards the row when the enrolment THROWS - the half production actually took', async () => {
    // A refusal is a race measured in microseconds. A database or Redis failure inside the enrolment
    // is an ordinary outage, and it left the row behind in exactly the same state.
    messaging.activateDeviceMembership.mockRejectedValue(new Error('connection terminated'));

    await expect(controller.createGroup(BODY)).rejects.toThrow('connection terminated');

    expect(groupRepo.save).toHaveBeenCalled();
    expect(groupRepo.delete).toHaveBeenCalledWith({
      id: (groupRepo.save.mock.calls[0][0] as { id: string }).id,
    });
  });

  it('passes the ORIGINAL failure on even when the discard itself fails', async () => {
    // The discard is housekeeping. Letting its own error replace the refusal would tell the caller
    // the wrong thing went wrong, and the row it failed to remove is then permanent - which is what
    // its ERROR line is for.
    messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });
    groupRepo.delete.mockRejectedValue(new Error('delete failed'));

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the row on the happy path, which is the whole point of it', async () => {
    await controller.createGroup(BODY);

    expect(groupRepo.save).toHaveBeenCalled();
    expect(groupRepo.delete).not.toHaveBeenCalled();
  });

  it("refuses the client's unresolved-identity placeholder - the 2026-08-27 defect reached this door too", async () => {
    // `updateInvitationStatus` was hardened against this and group creation never was, so a
    // placeholder could be stored as a real member of a real conversation.
    await expect(controller.createGroup({ ...BODY, createdBy: 'unknown' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(groupRepo.save).not.toHaveBeenCalled();
  });

  it('creates a memberless group without asking anything, when no creator device is given', async () => {
    // Not an error: the creator reaches it through the ordinary invitation path, and there is no
    // membership to gate.
    await controller.createGroup({ name: 'Amis', createdBy: 'u1' });

    expect(groupRepo.save).toHaveBeenCalled();
    expect(messaging.deviceAddressability).not.toHaveBeenCalled();
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });
});
