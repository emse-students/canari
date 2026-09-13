/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { FindOperator } from 'typeorm';
import { AppController } from './app.controller';
import { MessagingService } from './services/messaging.service';
import { GROUP_REDIS_KEY_PREFIXES, groupRedisKeys } from './utils/group-purge';
import { Group } from './entities/group.entity';
import { QueuedMessage } from './entities/queued-message.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { MlsCommitLog } from './entities/mls-commit-log.entity';
import { MlsGroupInfo } from './entities/mls-group-info.entity';
import { GroupInvite } from './entities/group-invite.entity';
import { UserDismissedGroup } from './entities/user-dismissed-group.entity';
import { KeyPackage } from './entities/key-package.entity';
import { OneTimeKeyPackage } from './entities/one-time-key-package.entity';
import { PushToken } from './entities/push-token.entity';
import { RevokedDevice } from './entities/revoked-device.entity';

/**
 * AN ORPHAN GROUP IS REPAIRED IN ONE WAY, FROM WHEREVER IT IS FOUND.
 *
 * A group with no row in `dm_groups` that still owns rows or Redis keys is an unfinished deletion.
 * Three paths meet one: a frame fetch and a history read repair the ids in front of them, and a
 * 6 h sweep goes looking. They agreed on `purgeOrphanGroups` for two of the three - and the third,
 * the sweep's Redis half, carried its own shorter answer: it scanned `group:members:*` and, for a
 * group absent from `dm_groups`, deleted THAT KEY and nothing else.
 *
 * That is worse than an incomplete repair. `group:members:<id>` was the only key through which the
 * group could still be found in Redis, so deleting it stranded the `history:` stream for ever:
 * no tombstone for the 90-day reaper, no membership row for the row sweep (which named two tables
 * out of six), and no key left for the key sweep. The repair destroyed the evidence of the residue
 * it left.
 *
 * So the table below drives all three PATHS over one policy rather than asserting on
 * `purgeOrphanGroups`: a path that deletes a key or a row itself is exactly what this file is here
 * to catch, and a test of the shared function would walk straight past it.
 */

const ORPHAN = 'g-gone';
const TOMBSTONED = 'g-dead';

/** What a purge takes, in order. A HARD delete: the group row is already gone, so the marker goes. */
const SWEPT = [
  QueuedMessage,
  GroupMember,
  DeviceGroupMembership,
  MlsCommitLog,
  MlsGroupInfo,
  GroupInvite,
  UserDismissedGroup,
];

/**
 * A distinctive fake table name per entity. The discovery reads the name from the entity's own
 * metadata, so asserting on these proves the SQL is GENERATED from the allowlist - a query that
 * spelled its tables as literals would name the real ones and fail here.
 */
const FAKE_TABLE = new Map<unknown, string>([
  [Group, 'table_of_group'],
  [QueuedMessage, 'table_of_queued_message'],
  [GroupMember, 'table_of_group_member'],
  [DeviceGroupMembership, 'table_of_device_membership'],
  [MlsCommitLog, 'table_of_commit_log'],
  [MlsGroupInfo, 'table_of_group_info'],
  [GroupInvite, 'table_of_invite'],
  [UserDismissedGroup, 'table_of_dismissal'],
]);

interface Path {
  name: string;
  /** Puts the group id where this path will meet it. */
  feed: (groupId: string) => void;
  /** Runs the path. */
  run: () => Promise<unknown>;
}

describe('an orphan group - one repair, three paths', () => {
  let service: MessagingService;
  let controller: AppController;

  /** What `dm_groups` holds, by id. A missing key is a group with no row at all. */
  let groups: Record<string, { id: string; deletedAt: Date | null }>;
  /** Every entity a delete was issued against, in order. */
  let swept: unknown[];
  /** The delivery queue this fake table holds. */
  let queue: Array<Partial<QueuedMessage>>;
  /** Group ids the discovery query is to report as owning rows while their group row is gone. */
  let orphanRowIds: string[];
  /** Group ids whose Redis keys exist, so `SCAN` finds them. */
  let redisOwners: Set<string>;
  /** Every SQL string handed to `manager.query`. */
  let queries: string[];
  /** Every `MATCH` pattern the scan asked for. */
  let scanned: string[];

  let redis: {
    del: jest.Mock;
    scan: jest.Mock;
    xrange: jest.Mock;
    xrevrange: jest.Mock;
    smembers: jest.Mock;
    exists: jest.Mock;
    publish: jest.Mock;
    xadd: jest.Mock;
    expire: jest.Mock;
    keys: jest.Mock;
  };

  let paths: Path[];
  /**
   * The history path addresses one group BY NAME, so the id it asks for has to be the one the case
   * staged. Every case stages exactly one, which keeps the three rows interchangeable.
   */
  let staged = ORPHAN;

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findBy: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const queryBuilder = () => {
    const state = { skip: 0, take: 0 };
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      skip: (n: number) => {
        state.skip = n;
        return qb;
      },
      take: (n: number) => {
        state.take = n;
        return qb;
      },
      getMany: async () => queue.slice(state.skip, state.skip + state.take),
    };
    return qb;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    groups = {};
    swept = [];
    queue = [];
    orphanRowIds = [];
    redisOwners = new Set();
    queries = [];
    scanned = [];

    redis = {
      del: jest.fn().mockResolvedValue(1),
      // One round, every key of every owner, filtered by the prefix asked for - so the patterns the
      // discovery uses are observable and a shape it forgets returns nothing.
      scan: jest.fn(async (_cursor: string, _match: string, pattern: string) => {
        scanned.push(pattern);
        const prefix = pattern.replace(/\*$/, '');
        const keys = [...redisOwners]
          .flatMap((id) => groupRedisKeys(id))
          .filter((key) => key.startsWith(prefix));
        return ['0', keys];
      }),
      xrange: jest.fn().mockResolvedValue([]),
      xrevrange: jest.fn().mockResolvedValue([]),
      smembers: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(0),
      publish: jest.fn(),
      xadd: jest.fn(),
      expire: jest.fn(),
      keys: jest.fn().mockResolvedValue([]),
    };

    const groupRepo = {
      ...emptyRepo(),
      // The presence read: `select: { id, deletedAt }` over the ids named. It returns tombstones,
      // because `deletedAt` is a plain column and only naming it excludes them.
      find: jest.fn(async ({ where }: { where: { id: FindOperator<string> } }) =>
        (where.id.value as unknown as string[]).map((id) => groups[id]).filter(Boolean)
      ),
      manager: {
        getRepository: jest.fn((entity: unknown) => ({
          metadata: { tableName: FAKE_TABLE.get(entity) ?? 'table_of_unknown' },
          delete: jest.fn(async () => {
            swept.push(entity);
            return { affected: 1 };
          }),
        })),
        query: jest.fn(async (sql: string) => {
          queries.push(sql);
          return orphanRowIds.map((groupId) => ({ groupId }));
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        MessagingService,
        {
          provide: getRepositoryToken(QueuedMessage),
          useValue: { ...emptyRepo(), createQueryBuilder: jest.fn(() => queryBuilder()) },
        },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    controller = module.get(AppController);
    for (const target of [service['logger'], controller['logger']]) {
      jest.spyOn(target, 'log').mockImplementation(() => undefined);
      jest.spyOn(target, 'warn').mockImplementation(() => undefined);
    }

    paths = [
      {
        name: 'a frame fetch',
        feed: (groupId) => {
          queue = [{ id: 'm1', groupId, proto: 'x'.repeat(64), createdAt: new Date(0) }];
        },
        run: () => service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined),
      },
      {
        name: 'a history read',
        // The id IS the argument; nothing to stage.
        feed: () => undefined,
        run: () => service.getHistory(staged, undefined, 'u1', 'true'),
      },
      {
        name: 'the 6 h orphan sweep',
        feed: (groupId) => {
          redisOwners.add(groupId);
        },
        run: () => controller['cleanupOrphanGroups'](),
      },
    ];
  });

  afterEach(() => jest.restoreAllMocks());

  describe.each([0, 1, 2])('path %i', (index) => {
    const stage = (groupId: string) => {
      staged = groupId;
      paths[index].feed(groupId);
    };

    it('takes everything an absent group owns in the database', async () => {
      stage(ORPHAN);

      await paths[index].run();

      expect(swept).toEqual(SWEPT);
    });

    it('takes every Redis key an absent group owns, and deletes none of them itself', async () => {
      stage(ORPHAN);

      await paths[index].run();

      // ONE call, carrying the three shapes together: a path that reached for a key on its own
      // would show up here as a second call, or as a first one naming a single shape.
      expect(redis.del.mock.calls).toEqual([groupRedisKeys(ORPHAN)]);
    });

    it('leaves a tombstoned group alone - its residue accuses the path that deleted it', async () => {
      groups[TOMBSTONED] = { id: TOMBSTONED, deletedAt: new Date(0) };
      stage(TOMBSTONED);

      await paths[index].run();

      expect(swept).toEqual([]);
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('leaves a live group alone', async () => {
      groups[ORPHAN] = { id: ORPHAN, deletedAt: null };
      stage(ORPHAN);

      await paths[index].run();

      expect(swept).toEqual([]);
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('what the sweep looks under', () => {
    it('scans every Redis shape a purge deletes, and only those', async () => {
      await controller['cleanupOrphanGroups']();

      expect(scanned).toEqual(GROUP_REDIS_KEY_PREFIXES.map((prefix) => `${prefix}*`));
      // The two halves are the same list read twice: a shape the purge deletes is a shape a group
      // can be found by, or the purge leaves something nothing will ever look for again.
      expect(scanned.map((p) => p.replace(/\*$/, ''))).toEqual([...GROUP_REDIS_KEY_PREFIXES]);
    });

    it('asks every table the purge sweeps, by the name the entity itself carries', async () => {
      await controller['cleanupOrphanGroups']();

      expect(queries).toHaveLength(1);
      const sql = queries[0];
      // One SELECT per swept table, `user_dismissed_groups` excepted: a dismissal is a fact about a
      // PERSON that may outlive the group, so it is residue to collect and never evidence to find a
      // group by.
      const discovered = SWEPT.filter((e) => e !== UserDismissedGroup);
      for (const entity of discovered) {
        expect(sql).toContain(`FROM "${FAKE_TABLE.get(entity)}" t`);
      }
      expect(sql.match(/SELECT DISTINCT/g)).toHaveLength(discovered.length);
      expect(sql).not.toContain(FAKE_TABLE.get(UserDismissedGroup));
      // Joined against the group table, also by its own name.
      expect(sql.match(/LEFT JOIN "table_of_group" g/g)).toHaveLength(discovered.length);
    });

    it('never calls a frame addressed to no group at all an orphan', async () => {
      // `queued_message.groupId` is NULLABLE: a system frame belongs to no group, so it satisfies
      // "no matching row in dm_groups" and would be reported as an orphan with a null id - and
      // then purged, under `IN (NULL)`.
      await controller['cleanupOrphanGroups']();

      expect(queries[0].match(/IS NOT NULL/g)).toHaveLength(SWEPT.length - 1);
    });

    it('hands the sweep nothing when the estate is clean', async () => {
      await controller['cleanupOrphanGroups']();

      expect(swept).toEqual([]);
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('purges a group found only by its rows, and one found only by its keys', async () => {
      // The two discoveries are not redundant. A group whose members are gone but whose commit log
      // is not is invisible to Redis; one whose only residue is a `history:` stream is invisible to
      // SQL. Before the fusion the row half named two tables of six and the key half named one
      // shape of three, so both of these were permanent.
      orphanRowIds = ['g-rows-only'];
      redisOwners.add('g-keys-only');

      await controller['cleanupOrphanGroups']();

      // ONE purge for both, not one each: the two discoveries meet before the repair, so a group
      // found by both halves is not swept twice either.
      expect(swept).toEqual(SWEPT);
      expect(redis.del.mock.calls).toEqual([
        [...groupRedisKeys('g-rows-only'), ...groupRedisKeys('g-keys-only')],
      ]);
    });
  });

  it('is driving three paths, and not one of them three times', () => {
    // The self-check: three rows landing on the same handler would make every case above a
    // statement about one path, and the divergence this file exists for would be invisible.
    expect(paths).toHaveLength(3);
    expect(new Set(paths.map((p) => p.run.toString())).size).toBe(3);
    expect(service).toBeInstanceOf(MessagingService);
    expect(controller).toBeInstanceOf(AppController);
  });
});
