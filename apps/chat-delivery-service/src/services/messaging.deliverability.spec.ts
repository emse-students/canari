/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import type { FindOperator } from 'typeorm';
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
import { GroupInvite } from '../entities/group-invite.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';

/**
 * A ROW IN `dm_groups` IS NOT A PLACE A FRAME CAN GO.
 *
 * `purgeOrphanGroups` used to answer "does the row exist" while its own doc named the other
 * question - "still present in `dm_groups` (deliverable)". The two differ by exactly the tombstones,
 * and a tombstone is not a destination: its members, its keys and its history are gone with it, so a
 * frame addressed to one can never be decrypted and never be ACKed. A client handed such a frame
 * asks for a Welcome no peer will answer, keeps the frame, and meets it again on the next
 * connection - a loop with no termination, because nothing in it consumes the frame. `deletedAt` is
 * a plain column rather than a `@DeleteDateColumn`, so `find` returns tombstones and only naming
 * them excludes them.
 *
 * Measured on production 2026-08-21: seven `queued_message` rows for one device, addressed to a
 * community distribution group tombstoned five hours earlier, redelivered on every connection since.
 *
 * The three cases are pinned apart because they accuse different code. An ACTIVE group is a
 * delivery. An ABSENT one is an incomplete deletion this call repairs. A TOMBSTONED one holding
 * queued rows is residue a delete path left behind, and the defect is at that path - so it is
 * dropped and named, never swept from here: a second collector would hide the first one's absence.
 */
describe('MessagingService - a tombstone is not a destination', () => {
  let service: MessagingService;

  /** The whole delivery queue this fake table holds, oldest first. */
  let table: Array<Partial<QueuedMessage>>;
  /** What `dm_groups` holds, by id. A missing key is a group with no row at all. */
  let groups: Record<string, { id: string; deletedAt: Date | null }>;
  /** Every entity the orphan purge asked to delete from, in order. Empty means nothing was swept. */
  let purged: unknown[];
  /** Every `warn` line the service wrote during the call. */
  let warnings: string[];

  const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

  const row = (id: string, groupId: string, atMs: number): Partial<QueuedMessage> => ({
    id,
    groupId,
    proto: 'x'.repeat(64),
    createdAt: new Date(BASE + atMs),
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
      getMany: async () => table.slice(state.skip, state.skip + state.take),
    };
    return qb;
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const redis = {
    xadd: jest.fn(),
    expire: jest.fn(),
    xrange: jest.fn().mockResolvedValue([]),
    xrevrange: jest.fn().mockResolvedValue([]),
    smembers: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(0),
    publish: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
  };

  const fetch = () => service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    table = [];
    groups = {};
    purged = [];
    warnings = [];

    const groupRepo = {
      ...emptyRepo(),
      // The read the sweep does: `select: { id, deletedAt }` over the ids named by the page. It has
      // to return tombstones, because that is what a plain column does and the whole defect lived
      // in forgetting it.
      find: jest.fn(async ({ where }: { where: { id: FindOperator<string> } }) =>
        (where.id.value as unknown as string[]).map((id) => groups[id]).filter(Boolean)
      ),
      manager: {
        getRepository: jest.fn((entity: unknown) => {
          purged.push(entity);
          return { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        {
          provide: getRepositoryToken(QueuedMessage),
          useValue: { ...emptyRepo(), createQueryBuilder: jest.fn(() => queryBuilder()) },
        },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation((m: unknown) => {
      warnings.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('delivers frames addressed to a live group', async () => {
    groups['g-live'] = { id: 'g-live', deletedAt: null };
    table = [row('m1', 'g-live', 0), row('m2', 'g-live', 1)];

    const page = await fetch();

    expect(page.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(purged).toEqual([]);
  });

  it('drops frames addressed to a tombstoned group, and sweeps nothing for it', async () => {
    // THE DEFECT, EXACTLY. Before the fix these two frames were delivered, could not be decrypted,
    // were never ACKed, and came back on every reconnection for ever.
    groups['g-dead'] = { id: 'g-dead', deletedAt: new Date(BASE) };
    table = [row('m1', 'g-dead', 0), row('m2', 'g-dead', 1)];

    const page = await fetch();

    expect(page).toEqual([]);
    // NOT swept from here: the rows exist because a delete path failed to take them, and the fix
    // belongs there. Collecting them here would make that path's failure invisible.
    expect(purged).toEqual([]);
  });

  it('names the tombstoned group, because a queued row for one accuses a delete path', async () => {
    groups['g-dead'] = { id: 'g-dead', deletedAt: new Date(BASE) };
    table = [row('m1', 'g-dead', 0)];

    await fetch();

    const line = warnings.find((w) => w.includes('undeliverable'));
    expect(line).toBeDefined();
    // The id, and what its presence means - a report that cannot be acted on is a report that will
    // not be. Both halves are asserted because the count alone cannot tell the two causes apart.
    expect(line).toContain('g-dead');
    expect(line).toContain('left residue');
  });

  it('accuses a tombstoned group ONCE per process, not once per fetch', async () => {
    // The residue is a STANDING FACT and not an event: the rows do not go away when they are read,
    // so a per-fetch line repeats for as long as they exist. Measured minutes after this shipped:
    // 134 warnings in one three-minute window, the same four ids over and over, because every client
    // asks on every reconnection. Once is enough to be found, which is the line's whole job.
    groups['g-dead'] = { id: 'g-dead', deletedAt: new Date(BASE) };
    table = [row('m1', 'g-dead', 0)];

    await fetch();
    const first = warnings.filter((w) => w.includes('left residue')).length;
    warnings = [];
    await fetch();
    const second = warnings.filter((w) => w.includes('left residue')).length;

    expect(first).toBe(1);
    expect(second).toBe(0);
    // The frame is still DROPPED on the second fetch - it is the accusation that is silenced, never
    // the behaviour, and the count of undeliverable rows is still reported.
    expect(warnings.some((w) => w.includes('undeliverable'))).toBe(true);
  });

  it('drops frames addressed to an absent group AND purges its residue', async () => {
    // No row at all: an incomplete deletion. Here the sweep IS the right answer - there is no
    // tombstone counting down to the reaper, so nothing else will ever collect these rows.
    table = [row('m1', 'g-gone', 0)];

    const page = await fetch();

    expect(page).toEqual([]);
    expect(purged).toEqual([
      QueuedMessage,
      GroupMember,
      DeviceGroupMembership,
      MlsCommitLog,
      MlsGroupInfo,
      GroupInvite,
      UserDismissedGroup,
    ]);
    expect(warnings.some((w) => w.includes('absent from dm_groups'))).toBe(true);
  });

  it('separates the two causes in one page holding both', async () => {
    // A page can name a live group, a dead one and a missing one at once, and the answer for each is
    // different. One filter covering all three would have to pick one of the three answers.
    groups['g-live'] = { id: 'g-live', deletedAt: null };
    groups['g-dead'] = { id: 'g-dead', deletedAt: new Date(BASE) };
    table = [row('m1', 'g-live', 0), row('m2', 'g-dead', 1), row('m3', 'g-gone', 2)];

    const page = await fetch();

    expect(page.map((m) => m.id)).toEqual(['m1']);
    // Only the absent one is swept, and the tombstone is named in the drop line.
    expect(purged).toContain(QueuedMessage);
    const line = warnings.find((w) => w.includes('undeliverable'));
    expect(line).toContain('g-dead');
    expect(line).not.toContain('g-gone');
  });

  it('refuses to serve the history of a tombstoned group, without reading the stream', async () => {
    // `deleteGroupOwnedRows` drops the `history:` stream with the rest of what the group owns, so a
    // tombstone can only ever answer an empty page. Saying so here costs one comparison; reading it
    // costs a Redis round-trip per request, per group, for ever.
    groups['g-dead'] = { id: 'g-dead', deletedAt: new Date(BASE) };

    const out = await service.getHistory('g-dead', undefined, 'u1', 'true');

    expect(out).toEqual({ rows: [] });
    expect(redis.xrange).not.toHaveBeenCalled();
  });
});
