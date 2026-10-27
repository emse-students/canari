/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { GroupsController } from './groups.controller';
import { InternalController } from './internal.controller';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { SeatEviction } from '../entities/seat-eviction.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * A GROUP ENDS IN THREE PLACES, AND IT MUST END THE SAME WAY IN ALL THREE.
 *
 * The user-facing `DELETE mls/groups/:groupId`, the internal retirement of a scope's distribution
 * group, and the DM half of an account deletion. Each one wrote the sequence out for itself: the
 * tombstone, the sweep of everything the group owns, the Redis keys, in that order and with that
 * flag. They agreed on the hard part - one allowlist defines what a group owns - and diverged on
 * everything around it, twice in the same direction: two of them once wrote the tombstone and swept
 * NOTHING, and because the row deliberately survives, the orphan sweep (which only finds groups
 * with NO row) could never collect the residue. It was permanent until the 90-day reaper - measured
 * on production 2026-08-21 as seven queued frames redelivered on every connection for five hours.
 *
 * So the table below drives all three ROUTES over one policy rather than asserting on the shared
 * function: a route that keeps its own `update` + `delete` pair is exactly what this file is here
 * to catch, and it would walk straight past a test of `tombstoneGroups` alone.
 */

const SECRET = 'internal-secret-for-tests';
const GROUP_ID = 'g-1';

/** The six tables a SOFT delete sweeps. `UserDismissedGroup` is deliberately not among them. */
const SWEPT = [
  GroupMember,
  QueuedMessage,
  QueuedPayload,
  DeviceGroupMembership,
  MlsCommitLog,
  MlsGroupInfo,
  GroupInvite,
  GroupMembershipInterval,
  SeatEviction,
];

interface Doors {
  groups: GroupsController;
  internal: InternalController;
}

interface Ending {
  name: string;
  /** Whatever the route needs to find the group it is about to end. */
  prepare?: (repos: Repos) => void;
  end: (doors: Doors) => Promise<unknown>;
  /** Only the distribution retirement releases the scope with the tombstone. */
  releasesScope: boolean;
}

const ENDINGS: Ending[] = [
  {
    name: 'the user-facing delete',
    // Asked by an admitted member, the only caller the route lets end a group.
    prepare: (repos) => {
      repos.group.findOne.mockResolvedValue({ id: GROUP_ID });
      repos.groupMember.findOne.mockResolvedValue({ id: 's-1', awaitingAdmission: false });
    },
    end: ({ groups }) => groups.deleteGroup(GROUP_ID, 'u1'),
    releasesScope: false,
  },
  {
    name: 'the retirement of a scope distribution group',
    prepare: (repos) => repos.group.findOne.mockResolvedValue({ id: GROUP_ID }),
    end: ({ internal }) => internal.deleteDistributionGroup('workspace', 'ws-1', SECRET),
    releasesScope: true,
  },
  {
    name: 'the DM half of an account deletion',
    prepare: (repos) => {
      repos.groupMember.find.mockResolvedValue([{ groupId: GROUP_ID, userId: 'u1' }]);
      repos.group.findBy.mockResolvedValue([{ id: GROUP_ID, isGroup: false }]);
    },
    end: ({ internal }) => internal.deleteUserData('u1', SECRET),
    releasesScope: false,
  },
];

type Repos = ReturnType<typeof makeRepos>;

function makeRepos() {
  return {
    group: {
      findOne: jest.fn().mockResolvedValue(null),
      findBy: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn(),
        // The account erasure's own-records half, outside the group sweep this file measures.
        // A SELECT answers rows (the account's eviction rows: none); a raw DELETE `[rows, count]`.
        query: jest.fn(async (sql: string) => (sql.trim().startsWith('SELECT') ? [] : [[], 0])),
        delete: jest.fn().mockResolvedValue({ affected: 0 }),
        // The account's key packages, deleted on their own before anything is read.
        getRepository: () => ({ delete: jest.fn().mockResolvedValue({ affected: 0 }) }),
      },
    },
    groupMember: {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    },
  };
}

describe('a group ends - one policy, three routes', () => {
  let doors: Doors;
  let repos: Repos;
  /** Every entity the sweep asked to delete inside the transaction, `Group` excluded. */
  let swept: unknown[];
  /** How many transactions tombstoned the group. */
  let sweeps: number;
  /** What happened, in order, so "Redis after the commit" is a fact rather than a hope. */
  let order: string[];
  let redis: {
    del: jest.Mock;
    srem: jest.Mock;
    smembers: jest.Mock;
    scan: jest.Mock;
    sadd: jest.Mock;
  };
  let previousSecret: string | undefined;

  beforeEach(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
    jest.clearAllMocks();
    swept = [];
    order = [];
    repos = makeRepos();

    // The transaction fake hands `Group` back to the real mock - so the tombstone assertions measure
    // the actual write - and every other entity to a counting fake, so a table dropped from the
    // sweep shows up as a missing name rather than as silence.
    //
    // ONLY THE TRANSACTION THAT TOMBSTONES THE GROUP IS THE SWEEP. Any other transaction never
    // touches `Group` - that is how they are told apart here.
    sweeps = 0;
    repos.group.manager.transaction.mockImplementation(
      async (cb: (m: unknown) => Promise<unknown>) => {
        let tombstones = false;
        const entities: unknown[] = [];
        const transactional = {
          getRepository: jest.fn((entity: unknown) => {
            if (entity === Group) {
              tombstones = true;
              return repos.group;
            }
            entities.push(entity);
            return {
              delete: jest.fn().mockResolvedValue({ affected: 1 }),
              // The account's device rows, read before they end: none left in these cases.
              find: jest.fn().mockResolvedValue([]),
            };
          }),
        };
        const out = await cb(transactional);
        if (tombstones) {
          sweeps += 1;
          swept.push(...entities);
          order.push('commit');
        }
        return out;
      }
    );

    redis = {
      // Only the group's own keys are the order under test; the erasure's later delete of the
      // account's own keys (notify list, presence) is not a group's.
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        if (keys.some((k) => k.startsWith('history:'))) order.push('redis');
        return 1;
      }),
      srem: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      // The erasure's route sweep walks the routing sets: none left in these cases.
      scan: jest.fn().mockResolvedValue(['0', []]),
      // The erasure's marker of the DMs it tombstones; read back empty here, so the run's own
      // key deletion is the one these cases order.
      sadd: jest.fn().mockResolvedValue(1),
    };

    const anyRepo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findBy: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      save: jest.fn(),
      // The erasure's count of the device rows it leaves for the final pass: none here.
      count: jest.fn().mockResolvedValue(0),
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupsController, InternalController],
      providers: [
        { provide: getRepositoryToken(Group), useValue: repos.group },
        { provide: getRepositoryToken(GroupMember), useValue: repos.groupMember },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: anyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: anyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: anyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: anyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: anyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: anyRepo() },
        { provide: getRepositoryToken(PinVerifier), useValue: anyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: anyRepo() },
        { provide: getRepositoryToken(GroupInvite), useValue: anyRepo() },
        { provide: getRepositoryToken(GroupMembershipInterval), useValue: anyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: {} as unknown as MessagingService },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    doors = {
      groups: module.get(GroupsController),
      internal: module.get(InternalController),
    };
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  describe.each(ENDINGS)('$name', ({ prepare, end, releasesScope }) => {
    it('writes the tombstone rather than deleting the row', async () => {
      prepare?.(repos);

      await end(doors);

      expect(repos.group.update).toHaveBeenCalledTimes(1);
      expect(repos.group.update).toHaveBeenCalledWith(
        { id: In([GROUP_ID]) },
        expect.objectContaining({ deletedAt: expect.any(Date) })
      );
      // The row SURVIVES: a lagging device observes the deletion instead of inferring it from a
      // group that simply stopped existing.
      expect(repos.group.delete).not.toHaveBeenCalled();
    });

    it('takes everything the group owns with it, in the same transaction', async () => {
      prepare?.(repos);

      await end(doors);

      expect(sweeps).toBe(1);
      expect(swept).toEqual(SWEPT);
    });

    it('keeps the per-user dismissal markers, which are facts about people', async () => {
      prepare?.(repos);

      await end(doors);

      // A soft delete leaves the tombstone, so discovery still runs against it and the question the
      // marker answers - "I dismissed this" versus "somebody deleted it" - is still live.
      expect(swept).not.toContain(UserDismissedGroup);
    });

    it('clears the Redis keys, and only after the transaction has committed', async () => {
      prepare?.(repos);

      await end(doors);

      expect(redis.del).toHaveBeenCalledWith(
        `history:${GROUP_ID}`,
        `group:members:${GROUP_ID}`,
        `pending_welcome:${GROUP_ID}`,
        `group:parting:${GROUP_ID}`
      );
      // The reverse order would strip a live group's history if the transaction then rolled back.
      expect(order).toEqual(['commit', 'redis']);
    });

    it('releases the distribution scope exactly when this route owns one', async () => {
      prepare?.(repos);

      await end(doors);

      const written = repos.group.update.mock.calls[0][1] as Record<string, unknown>;
      expect('distributionWorkspaceId' in written).toBe(releasesScope);
      expect('distributionChannelId' in written).toBe(releasesScope);
    });
  });

  it('is driving three routes, and not one of them three times', () => {
    // The self-check: three rows landing on the same handler would make every case above a statement
    // about one route, and the divergence this file exists for would be invisible.
    expect(ENDINGS).toHaveLength(3);
    expect(new Set(ENDINGS.map((e) => e.end.toString())).size).toBe(3);
    expect(doors.groups).toBeInstanceOf(GroupsController);
    expect(doors.internal).toBeInstanceOf(InternalController);
  });
});
