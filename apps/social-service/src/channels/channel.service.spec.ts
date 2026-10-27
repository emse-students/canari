import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { CHANNEL_SIGNATURE_REQUIRED, ChannelService, clientIdLockSql } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import {
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  PIN_REQUIRES_MODERATION,
} from './permissions';
import { fakeDepartureManager } from './departure-transaction.fake-spec';
import { roleUpdateBuilder } from './member-role-update.fake-spec';

/** A well-formed Graine v2 signature: every salon row carries one (channel-encryption 21.8). */
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

/** A client message id as `crypto.randomUUID()` mints it (migration 090). */
const CLIENT_ID = '3f1c2b9a-7d4e-4c1a-9b2e-5a6d7c8e9f01';

describe('ChannelService security hardening', () => {
  const previousSecret = process.env.INTERNAL_SECRET;

  beforeEach(() => {
    // Deleting a community now takes its Graine key-distribution group with it, and that group
    // lives in chat-delivery. The call is deliberately allowed to abort the deletion (an orphan
    // group is the one outcome nothing can reconcile later), so these tests have to answer it -
    // otherwise every deletion here fails on an unreachable service rather than on its own logic.
    // Behaviour when that call FAILS is covered in `distribution-group.spec.ts`.
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ groupId: 'g-1', created: true, deleted: true })),
      } as unknown as Response)
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  function makeService() {
    // Every table a hard delete has to name, funnelled through one spy: nothing cascades on
    // `channel_workspaces`, so the COUNT of deletes is the assertion worth making.
    const hardDeletes = jest.fn(() => Promise.resolve({ affected: 1 }));
    const workspaceRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      // A community setting is one column update of the row; 1 row found.
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      manager: {
        // The deletion takes the community removal lock (`query`) and asks its premise again
        // through the member and role repositories.
        transaction: jest.fn((cb: (m: Record<string, unknown>) => Promise<void>) =>
          cb({
            delete: hardDeletes,
            query: jest.fn(() => Promise.resolve([])),
            getRepository: (entity: unknown) => (entity === ChannelRole ? roleRepo : memberRepo),
          })
        ),
      },
    };
    const channelRepo = {
      findOne: jest.fn(),
      // Empty by default rather than undefined: `find` is now on the departure path (every private
      // salon a leaver must be cut from), and a bare `jest.fn()` there fails as a TypeError deep
      // inside the service instead of as the assertion the test is about.
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
    };
    const roleRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    const memberRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn(),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      delete: jest.fn(),
      // An admission re-checks, under the removal lock, that the community still has members;
      // one member by default, so only the test about an emptied community sees zero.
      count: jest.fn(() => Promise.resolve(1)),
    };
    // The Graine history floor is the one read that goes through a query builder rather than a
    // `find`. Rows are pushed in by the test that needs them, so every other test sees the honest
    // default - no message readable by anybody - instead of a builder that throws.
    const floorRows: { sessionId: string; floor: string }[] = [];
    const floorBuilder: Record<string, unknown> = {
      getRawMany: jest.fn(() => Promise.resolve(floorRows)),
    };
    for (const step of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      floorBuilder[step] = jest.fn(() => floorBuilder);
    }
    const messageRepo = {
      createQueryBuilder: jest.fn(() => floorBuilder),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
      // Raw SQL: the client-id tombstones of migration 090 (none by default).
      query: jest.fn((_sql: string, _params?: unknown[]) => Promise.resolve([] as unknown[])),
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(),
      },
    };
    // By default a transaction runs against the repository itself: the client-id lock, the
    // tombstone and the row land in `query`, `save` and `delete` above, in order.
    messageRepo.manager.transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
      cb({ query: messageRepo.query, getRepository: () => messageRepo })
    );
    const inviteRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      increment: jest.fn(() => Promise.resolve()),
      delete: jest.fn(() => Promise.resolve({ affected: 0 })),
    };
    const redis = {
      publishChannelEvent: jest.fn(() => Promise.resolve()),
      onlineUserIds: jest.fn((_ids: readonly string[]) => Promise.resolve(new Set<string>())),
      onlineDevicesByUser: jest.fn((_ids: readonly string[]) =>
        Promise.resolve(new Map<string, string[]>())
      ),
    };

    Object.assign(memberRepo, {
      manager: fakeDepartureManager(() => ({ channelRepo, memberRepo, roleRepo, inviteRepo })),
    });
    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      inviteRepo as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );

    return {
      service,
      workspaceRepo,
      channelRepo,
      roleRepo,
      memberRepo,
      messageRepo,
      inviteRepo,
      redis,
      hardDeletes,
      floorRows,
    };
  }

  /** Wires messageRepo.manager.transaction to run the callback against a locked `msg`. */
  function lockMessage(
    messageRepo: { manager: { transaction: jest.Mock } },
    msg: Partial<ChannelMessage> | null
  ) {
    const manager = {
      createQueryBuilder: () => ({
        where: () => ({
          setLock: () => ({ getOne: () => Promise.resolve(msg) }),
        }),
      }),
      save: (m: unknown) => Promise.resolve(m),
    };
    messageRepo.manager.transaction.mockImplementation((cb: (m: typeof manager) => Promise<void>) =>
      cb(manager)
    );
  }

  /** Common channel + member access mocks for poll voting tests. */
  function arrangePollAccess(
    channelRepo: { findOne: jest.Mock },
    memberRepo: { findOne: jest.Mock; find: jest.Mock }
  ) {
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      keyVersion: 1,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
    memberRepo.find.mockResolvedValue([]);
  }

  it('listMessages without a cursor filters only by channelId', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.find.mockResolvedValue([]);

    await service.listMessages('ch1', 'u1', 50);

    const where = messageRepo.find.mock.calls[0][0].where;
    expect(where.channelId).toBe('ch1');
    expect(where.createdAt).toBeUndefined();
  });

  it('listMessages with a `before` cursor adds a strict createdAt filter (keyset pagination)', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.find.mockResolvedValue([]);
    const cursor = '2026-07-01T12:00:00.000Z';

    await service.listMessages('ch1', 'u1', 50, cursor);

    const where = messageRepo.find.mock.calls[0][0].where;
    // TypeORM LessThan yields a FindOperator whose value is the parsed cursor date.
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.value).toEqual(new Date(cursor));
  });

  it('listMessages ignores an invalid `before` cursor rather than filtering everything out', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.find.mockResolvedValue([]);

    await service.listMessages('ch1', 'u1', 50, 'not-a-date');

    const where = messageRepo.find.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
  });

  it('votePoll rejects a message that is not a poll', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, { id: 'm1', channelId: 'ch1', metadata: {} });

    await expect(service.votePoll('ch1', 'm1', 'u1', ['a'])).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('votePoll rejects a closed poll', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, {
      id: 'm1',
      channelId: 'ch1',
      metadata: {
        poll: {
          optionIds: ['a', 'b'],
          multipleChoice: false,
          endsAt: new Date(Date.now() - 1000).toISOString(),
          votesByUser: {},
        },
      },
    });

    await expect(service.votePoll('ch1', 'm1', 'u1', ['a'])).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('votePoll rejects multiple selections on a single-choice poll', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, {
      id: 'm1',
      channelId: 'ch1',
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    });

    await expect(service.votePoll('ch1', 'm1', 'u1', ['a', 'b'])).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('votePoll records the vote and broadcasts the updated tally', async () => {
    const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = {
      id: 'm1',
      channelId: 'ch1',
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    };
    lockMessage(messageRepo, msg);

    const result = await service.votePoll('ch1', 'm1', 'u1', ['b']);
    expect(result.votesByUser).toEqual({ u1: ['b'] });
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.poll.vote',
      expect.objectContaining({ channelId: 'ch1', messageId: 'm1' }),
      expect.any(Array)
    );
  });

  it('closePoll by the author forces the deadline and unpins the message', async () => {
    const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'u1',
      pinned: true,
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    };
    lockMessage(messageRepo, msg);

    const result = await service.closePoll('ch1', 'm1', 'u1');
    expect(typeof result.endsAt).toBe('string');
    expect(new Date(result.endsAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(msg.pinned).toBe(false);
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.poll.vote',
      expect.objectContaining({ channelId: 'ch1', messageId: 'm1' }),
      expect.any(Array)
    );
  });

  /*
   * WHOSE CLOCK ANSWERS "IS IT OVER". A deadline is an instant on THIS clock, so a client comparing
   * it to its own decides with the wrong one - and the margin is zero exactly when it matters. A
   * poll closed *now* was read a few hundred milliseconds later against a client clock half a second
   * behind, the comparison came out false, and nothing re-ran it: the card stayed open for ever
   * while this side answered 403 to every vote (COMM-15, measured on production 2026-08-25).
   *
   * So the answer travels as a statement. These three pin the statement, its delivery, and the fact
   * that it is never written down.
   */
  it('closePoll STATES the closure rather than leaving a deadline to be compared', async () => {
    const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'u1',
      pinned: true,
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    };
    lockMessage(messageRepo, msg);

    const result = await service.closePoll('ch1', 'm1', 'u1');
    expect(result.closed).toBe(true);

    // AND EVERY MEMBER IS TOLD THE SAME THING the closer was: one poll, one verdict.
    const calls = redis.publishChannelEvent.mock.calls as unknown as [
      string,
      { poll: { closed: boolean } },
    ][];
    const frame = calls.find((c) => c[0] === 'channel.poll.vote');
    expect(frame?.[1].poll.closed).toBe(true);
  });

  it('does not persist the statement, which is true of an instant and not of the row', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'u1',
      pinned: true,
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    };
    lockMessage(messageRepo, msg);

    await service.closePoll('ch1', 'm1', 'u1');
    // A stored `closed` would be a boolean nothing keeps true - the deadline is the durable fact.
    expect(Object.keys(msg.metadata.poll)).not.toContain('closed');
  });

  it('says an open poll is open, so `closed` is an answer and not a marker of the close route', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, {
      id: 'm1',
      channelId: 'ch1',
      metadata: {
        poll: {
          optionIds: ['a', 'b'],
          multipleChoice: false,
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          votesByUser: {},
        },
      },
    });

    expect((await service.votePoll('ch1', 'm1', 'u1', ['b'])).closed).toBe(false);
  });

  it('closePoll rejects a non-author without a moderation permission', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'someone-else',
      pinned: true,
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    });

    await expect(service.closePoll('ch1', 'm1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('closePoll lets a moderator close another member poll', async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['channel.moderate'] }]);
    const msg = {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'someone-else',
      pinned: true,
      metadata: {
        poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null, votesByUser: {} },
      },
    };
    lockMessage(messageRepo, msg);

    const result = await service.closePoll('ch1', 'm1', 'u1');
    expect(typeof result.endsAt).toBe('string');
    expect(msg.pinned).toBe(false);
  });

  it('closePoll rejects an already-closed poll', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    lockMessage(messageRepo, {
      id: 'm1',
      channelId: 'ch1',
      authorId: 'u1',
      pinned: false,
      metadata: {
        poll: {
          optionIds: ['a', 'b'],
          multipleChoice: false,
          endsAt: new Date(Date.now() - 1000).toISOString(),
          votesByUser: {},
        },
      },
    });

    await expect(service.closePoll('ch1', 'm1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── History visibility (WP-35) ────────────────────────────────────────────
  // The server stores and broadcasts this and can enforce nothing: it holds no seed. What it CAN
  // do is refuse a word no client knows and make sure every member hears the change - a member
  // still holding 'shared' in memory would keep handing the past over after an admin closed it.

  it('updateWorkspaceHistoryVisibility broadcasts the new rule to every member', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo, redis } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', historyVisibility: 'shared' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions: ['workspace.manage'] }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

    const result = await service.updateWorkspaceHistoryVisibility('ws1', 'u1', 'joined');

    expect(result).toEqual({ success: true, workspaceId: 'ws1', historyVisibility: 'joined' });
    expect(workspaceRepo.update).toHaveBeenCalledWith(
      { id: 'ws1' },
      { historyVisibility: 'joined' }
    );
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'workspace.updated',
      { workspaceId: 'ws1', historyVisibility: 'joined' },
      expect.arrayContaining(['u1', 'u2'])
    );
  });

  it('updateWorkspaceHistoryVisibility refuses a value no client knows', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions: ['workspace.manage'] }]);

    // Stored unchecked, it would reach every device as a word none of them recognises - and each
    // of them would have to guess, on the one decision that hands over the past.
    await expect(
      service.updateWorkspaceHistoryVisibility('ws1', 'u1', 'everyone' as never)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workspaceRepo.update).not.toHaveBeenCalled();
  });

  it('updateWorkspaceHistoryVisibility refuses a member without MANAGE_WORKSPACE', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions: ['member.invite'] }]);

    await expect(
      service.updateWorkspaceHistoryVisibility('ws1', 'u1', 'joined')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaceRepo.update).not.toHaveBeenCalled();
  });

  // ── Member removal broadcasts ─────────────────────────────────────────────
  // Both events fan out to every remaining member as well as the target, so the payload is the
  // only thing a client can use to tell whose access changed and whether anything was lost.
  // No compiler checks this across the two services.

  it('kickFromWorkspace names the removed user and carries no channel', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo, redis } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['member.kick'] }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u-bob', roleIds: [] }]);

    await service.kickFromWorkspace('ws1', 'u-bob', 'u1');

    // The exact payload matters: an absent channelId is what marks the removal as
    // community-wide on the client, and the target must be in the notify list.
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.member.kicked',
      { workspaceId: 'ws1', kickedUserId: 'u-bob', kickedBy: 'u1' },
      expect.arrayContaining(['u-bob'])
    );
  });

  it('a kick names the committing device the actor sent, and drops a malformed one', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo, redis } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['member.kick'] }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u-bob', roleIds: [] }]);

    await service.kickFromWorkspace('ws1', 'u-bob', 'u1', 'web-1');
    expect(redis.publishChannelEvent).toHaveBeenLastCalledWith(
      'channel.member.kicked',
      { workspaceId: 'ws1', kickedUserId: 'u-bob', kickedBy: 'u1', actorDeviceId: 'web-1' },
      expect.any(Array)
    );

    await service.kickFromWorkspace('ws1', 'u-bob', 'u1', 'not/a device');
    expect(redis.publishChannelEvent).toHaveBeenLastCalledWith(
      'channel.member.kicked',
      { workspaceId: 'ws1', kickedUserId: 'u-bob', kickedBy: 'u1' },
      expect.any(Array)
    );
  });

  it('a kick whose announcement fails is still a kick, not a 500', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo, redis } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['member.kick'] }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u-bob', roleIds: [] }]);
    redis.publishChannelEvent.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.kickFromWorkspace('ws1', 'u-bob', 'u1')).resolves.toEqual({
      success: true,
    });
  });

  it('removeMemberFromChannel reports whether the channel was private', async () => {
    const { service, channelRepo, memberRepo, roleRepo, redis } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      name: 'staff',
      isPrivate: true,
      allowedUsers: ['u-bob'],
      keyVersion: 1,
      masterSecret: Buffer.alloc(32).toString('base64'),
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['member.kick'] }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u-bob', roleIds: [] }]);

    await service.removeMemberFromChannel('ch1', 'u-bob', 'u1');

    // Without isPrivate the target cannot tell a real loss from a public channel they keep.
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.member.removed',
      expect.objectContaining({
        channelId: 'ch1',
        removedUserId: 'u-bob',
        removedBy: 'u1',
        isPrivate: true,
      }),
      expect.arrayContaining(['u-bob'])
    );
  });

  // ── Channel moderation (`channel.moderate`) ───────────────────────────────
  // The role matrix advertises this permission as "pin or delete other members' messages".
  // These cases pin down that the matrix and the enforcement agree - the whole point of the
  // permission is that it grants something a plain member does not have.

  it('deleteChannelMessage lets the author delete their own message', async () => {
    const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.findOne.mockResolvedValue({ id: 'm1', channelId: 'ch1', authorId: 'u1' });
    // The row lock finds the row.
    messageRepo.query.mockResolvedValueOnce([{}]);

    await service.deleteChannelMessage('ch1', 'm1', 'u1');

    expect(messageRepo.delete).toHaveBeenCalledWith({ id: 'm1', channelId: 'ch1' });
    // In ONE transaction (migration 090): the ROW's lock first (what an account erasure's delete
    // waits on, or makes this wait on), then the client id's lock - the one a send takes around its
    // tombstone check and its insert - then the tombstone, then the row.
    expect(messageRepo.manager.transaction).toHaveBeenCalledTimes(1);
    const [[rowSql, rowParams], [lockSql, lockParams], [sql, params]] =
      messageRepo.query.mock.calls;
    expect(rowSql).toContain('FOR UPDATE');
    expect(rowParams).toEqual(['m1', 'ch1']);
    expect(lockSql).toContain(clientIdLockSql('"authorId"', '"channelId"', '"clientMessageId"'));
    expect(lockParams).toEqual(['m1', 'ch1']);
    expect(sql).toContain('INSERT INTO channel_message_client_tombstones');
    expect(params).toEqual(['m1', 'ch1']);
    expect(messageRepo.query.mock.invocationCallOrder[2]).toBeLessThan(
      messageRepo.delete.mock.invocationCallOrder[0]
    );
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.message.deleted',
      expect.objectContaining({ channelId: 'ch1', messageId: 'm1', deletedBy: 'u1' }),
      expect.any(Array)
    );
  });

  it("deleteChannelMessage rejects a plain member deleting someone else's message", async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.findOne.mockResolvedValue({
      id: 'm1',
      channelId: 'ch1',
      authorId: 'someone-else',
    });

    await expect(service.deleteChannelMessage('ch1', 'm1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(messageRepo.delete).not.toHaveBeenCalled();
  });

  it("deleteChannelMessage lets a channel.moderate holder delete someone else's message", async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['channel.moderate'] }]);
    messageRepo.findOne.mockResolvedValue({
      id: 'm1',
      channelId: 'ch1',
      authorId: 'someone-else',
    });
    messageRepo.query.mockResolvedValueOnce([{}]);

    await service.deleteChannelMessage('ch1', 'm1', 'u1');

    expect(messageRepo.delete).toHaveBeenCalledWith({ id: 'm1', channelId: 'ch1' });
  });

  it('deleteChannelMessage writes NO tombstone for a row removed while it waited (an erasure)', async () => {
    const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    messageRepo.findOne.mockResolvedValue({ id: 'm1', channelId: 'ch1', authorId: 'u1' });
    // Read before the transaction, gone once its row lock was granted.
    messageRepo.query.mockResolvedValueOnce([]);

    await service.deleteChannelMessage('ch1', 'm1', 'u1');

    expect(messageRepo.query).toHaveBeenCalledTimes(1);
    expect(messageRepo.delete).not.toHaveBeenCalled();
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.message.deleted',
      expect.objectContaining({ messageId: 'm1' }),
      expect.any(Array)
    );
  });

  it("setMessagePinned rejects a plain member pinning someone else's message", async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = { id: 'm1', channelId: 'ch1', authorId: 'someone-else', pinned: false };
    messageRepo.findOne.mockResolvedValue(msg);

    await expect(service.setMessagePinned('ch1', 'm1', 'u1', true)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(msg.pinned).toBe(false);
  });

  it("setMessagePinned lets a channel.moderate holder pin someone else's message", async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ permissions: ['channel.moderate'] }]);
    const msg = { id: 'm1', channelId: 'ch1', authorId: 'someone-else', pinned: false };
    messageRepo.findOne.mockResolvedValue(msg);

    await service.setMessagePinned('ch1', 'm1', 'u1', true);

    expect(msg.pinned).toBe(true);
  });

  it('setMessagePinned types its refusal, and neither saves nor announces anything', async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    // The seeded Membre role holds NOTHING - the rank a plain member actually has.
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['membre'] });
    roleRepo.find.mockResolvedValue([{ id: 'membre', permissions: DEFAULT_MEMBER_PERMISSIONS }]);
    messageRepo.findOne.mockResolvedValue({
      id: 'm1',
      channelId: 'ch1',
      authorId: 'someone-else',
      pinned: false,
    });

    const refusal = await service.setMessagePinned('ch1', 'm1', 'u1', true).catch((e) => e);

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getStatus()).toBe(403);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: PIN_REQUIRES_MODERATION,
    });
    expect(messageRepo.save).not.toHaveBeenCalled();
    expect(redis.publishChannelEvent).not.toHaveBeenCalled();
  });

  it("setMessagePinned refuses a plain member UNPINNING someone else's message too", async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const msg = { id: 'm1', channelId: 'ch1', authorId: 'someone-else', pinned: true };
    messageRepo.findOne.mockResolvedValue(msg);

    await expect(service.setMessagePinned('ch1', 'm1', 'u1', false)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(msg.pinned).toBe(true);
  });

  // A pin shows on every member's screen, so the author is NOT exempt (user, 2026-10-05).
  it.each([true, false])(
    'setMessagePinned refuses a plain member pinned=%s on their OWN message',
    async (pinned) => {
      const { service, channelRepo, memberRepo, messageRepo, redis } = makeService();
      arrangePollAccess(channelRepo, memberRepo);
      const msg = { id: 'm1', channelId: 'ch1', authorId: 'u1', pinned: !pinned };
      messageRepo.findOne.mockResolvedValue(msg);

      const refusal = await service.setMessagePinned('ch1', 'm1', 'u1', pinned).catch((e) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: PIN_REQUIRES_MODERATION,
      });
      expect(msg.pinned).toBe(!pinned);
      expect(redis.publishChannelEvent).not.toHaveBeenCalled();
    }
  );

  it('setMessagePinned lets a moderator pin their own message', async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo, redis } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions: DEFAULT_MODERATOR_PERMISSIONS }]);
    const msg = { id: 'm1', channelId: 'ch1', authorId: 'u1', pinned: false };
    messageRepo.findOne.mockResolvedValue(msg);

    await service.setMessagePinned('ch1', 'm1', 'u1', true);

    expect(msg.pinned).toBe(true);
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.pin',
      { channelId: 'ch1', messageId: 'm1', pinned: true },
      expect.any(Array)
    );
  });

  it.each([
    ['the seeded Moderateur', DEFAULT_MODERATOR_PERMISSIONS],
    ['the seeded Administrateur', DEFAULT_ADMIN_PERMISSIONS],
    ['a role holding only channel.manage', ['channel.manage']],
  ])("setMessagePinned lets %s pin someone else's message", async (_label, permissions) => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions }]);
    const msg = { id: 'm1', channelId: 'ch1', authorId: 'someone-else', pinned: false };
    messageRepo.findOne.mockResolvedValue(msg);

    await service.setMessagePinned('ch1', 'm1', 'u1', true);

    expect(msg.pinned).toBe(true);
  });

  // ── Silent rows (WP-40) ───────────────────────────────────────────────────
  // A reaction is an encrypted message now. The server holds no tally, and the only thing it
  // learns about such a row is that it must not ring a phone.

  it('sendMessage does not notify for a silent row', async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      writePolicy: 'everyone',
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
    roleRepo.find.mockResolvedValue([]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    messageRepo.create.mockImplementation((v: any) => v);
    messageRepo.save.mockImplementation(async (v: any) => ({
      ...v,
      id: 'm-new',
      createdAt: new Date(),
    }));
    const notify = jest
      .spyOn(service as any, 'notifyChannelRecipients')
      .mockResolvedValue(undefined);

    await service.sendMessage('ch1', {
      senderId: 'u1',
      ciphertext: 'c',
      nonce: 'n',
      senderSessionId: 's-1',
      messageIndex: 0,
      signature: SIGNATURE,
      silent: true,
    });

    // A heart that rang every phone in the community is a community people mute.
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });

  // A pin shows on every member's screen, so a poll is auto-pinned only for an author who may pin
  // (user, 2026-10-05). Matrix: plain member -> not pinned; moderator -> pinned.
  it.each([
    ['a plain member', ['membre'], DEFAULT_MEMBER_PERMISSIONS, false],
    ['a moderator', ['mod'], ['channel.moderate'], true],
  ])('sendMessage with a poll by %s: pinned=%s', async (_who, roleIds, permissions, pinned) => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      writePolicy: 'everyone',
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds });
    roleRepo.find.mockResolvedValue([{ id: roleIds[0], permissions }]);
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }]);
    messageRepo.create.mockImplementation((v: any) => v);
    messageRepo.save.mockImplementation(async (v: any) => ({
      ...v,
      id: 'm-new',
      createdAt: new Date(),
    }));
    jest.spyOn(service as any, 'notifyChannelRecipients').mockResolvedValue(undefined);

    await service.sendMessage('ch1', {
      senderId: 'u1',
      ciphertext: 'c',
      nonce: 'n',
      senderSessionId: 's-1',
      messageIndex: 0,
      signature: SIGNATURE,
      poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null },
    } as any);

    const created = messageRepo.create.mock.calls[0][0] as any;
    expect(created.pinned).toBe(pinned);
    expect(created.metadata.poll).toBeDefined();
  });

  it('listMessages fills its page with bodies and adds the silent rows inside it', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const body = (id: string, ms: number) => ({
      id,
      channelId: 'ch1',
      authorId: 'u1',
      content: 'c',
      createdAt: new Date(ms),
      silent: false,
      metadata: {},
    });
    const silent = (id: string, ms: number) => ({ ...body(id, ms), silent: true });
    messageRepo.find.mockImplementation(async (opts: any) =>
      opts.where.silent === true ? [silent('r1', 150)] : [body('m2', 200), body('m1', 100)]
    );

    const page = await service.listMessages('ch1', 'u1', 2);

    // Without the split, a burst of reactions would push real messages out of the page - a channel
    // that shows less history the more people react to it, with nothing saying so.
    expect(page.map((m) => m.id)).toEqual(['m2', 'r1', 'm1']);
    expect(page.find((m) => m.id === 'r1')?.silent).toBe(true);
  });

  // A membership notice is sent silent (it must not count as unread nor ring a phone), so a salon
  // holding nothing else would otherwise open on an empty history.
  it('listMessages returns the silent rows of a salon that has no body at all', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    arrangePollAccess(channelRepo, memberRepo);
    const notice = {
      id: 'n1',
      channelId: 'ch1',
      authorId: 'u1',
      content: 'c',
      createdAt: new Date(100),
      silent: true,
      metadata: {},
    };
    messageRepo.find.mockImplementation(async (opts: any) =>
      opts.where.silent === true ? [notice] : []
    );

    const page = await service.listMessages('ch1', 'u1', 50);

    expect(page.map((m) => m.id)).toEqual(['n1']);
  });

  // A join notice is written BEFORE the salon's first body (the member joins, then speaks). The
  // silent rows used to be fetched only from the oldest body down, so on a salon shorter than one
  // page that notice was in no page at all: no later page is ever asked for below a short one.
  describe('listMessages on a salon shorter than one page (notice, then body, then the page)', () => {
    const row = (id: string, ms: number, silent: boolean) => ({
      id,
      channelId: 'ch1',
      authorId: 'u1',
      content: 'c',
      createdAt: new Date(ms),
      silent,
      metadata: {},
    });
    // Evaluates the TypeORM operators the service builds, so the fixture is filtered the way
    // PostgreSQL would filter it rather than by what each test pre-decides to return.
    const matches = (op: any, d: Date): boolean => {
      if (op === undefined) return true;
      switch (op.type) {
        case 'lessThan':
          return d.getTime() < op.value.getTime();
        case 'moreThanOrEqual':
          return d.getTime() >= op.value.getTime();
        case 'and':
          return (op.value as any[]).every((o) => matches(o, d));
        default:
          throw new Error(`unexpected operator ${op.type}`);
      }
    };
    const serve = (rows: ReturnType<typeof row>[]) => async (opts: any) =>
      rows
        .filter((r) => r.silent === opts.where.silent && matches(opts.where.createdAt, r.createdAt))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, opts.take ?? Infinity);

    it('returns the notice older than the first body', async () => {
      const { service, channelRepo, memberRepo, messageRepo } = makeService();
      arrangePollAccess(channelRepo, memberRepo);
      messageRepo.find.mockImplementation(serve([row('join', 100, true), row('m1', 200, false)]));

      const page = await service.listMessages('ch1', 'u1', 50);

      expect(page.map((m) => m.id)).toEqual(['m1', 'join']);
    });

    it('still bounds the silent rows by the cursor on a short page', async () => {
      const { service, channelRepo, memberRepo, messageRepo } = makeService();
      arrangePollAccess(channelRepo, memberRepo);
      messageRepo.find.mockImplementation(
        serve([row('join', 100, true), row('m1', 200, false), row('late', 400, true)])
      );

      const page = await service.listMessages('ch1', 'u1', 50, new Date(300).toISOString());

      expect(page.map((m) => m.id)).toEqual(['m1', 'join']);
    });

    it('keeps the lower bound on a FULL page, whose older silent rows belong to the next one', async () => {
      const { service, channelRepo, memberRepo, messageRepo } = makeService();
      arrangePollAccess(channelRepo, memberRepo);
      messageRepo.find.mockImplementation(
        serve([row('join', 100, true), row('m1', 200, false), row('m2', 300, false)])
      );

      const page = await service.listMessages('ch1', 'u1', 2);

      expect(page.map((m) => m.id)).toEqual(['m2', 'm1']);
    });
  });

  it('rejects listMessages for a private channel when the user is neither admin nor allow-listed', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: true,
      allowedUsers: ['someone-else'],
      keyVersion: 1,
      masterSecret: Buffer.alloc(32).toString('base64'),
    });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'u1',
      roleIds: ['r-member'],
    });
    // Non-admin role: no workspace.manage -> no private-channel bypass.
    roleRepo.find.mockResolvedValue([{ permissions: ['member.invite'] }]);

    await expect(service.listMessages('ch1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an admin a private channel they have not joined', async () => {
    // Inverted on 2026-08-19 by the user's decision. `workspace.manage` used to be a bypass into
    // every private salon; under a distribution group per salon that would make every promotion a
    // commit on every one of them, and it made the salon's own roster unreadable to its members.
    // An admin joins, which is one act and one commit, and then appears in `allowedUsers`.
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: true,
      allowedUsers: ['someone-else'],
      keyVersion: 1,
      masterSecret: Buffer.alloc(32).toString('base64'),
    });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'admin',
      roleIds: ['r-admin'],
    });
    roleRepo.find.mockResolvedValue([{ permissions: ['workspace.manage'] }]);
    messageRepo.find.mockResolvedValue([]);

    await expect(service.listMessages('ch1', 'admin')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('grants an admin the same private channel once they have joined it', async () => {
    const { service, channelRepo, memberRepo, roleRepo, messageRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: true,
      allowedUsers: ['someone-else', 'admin'],
      keyVersion: 1,
      masterSecret: Buffer.alloc(32).toString('base64'),
    });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'admin',
      roleIds: ['r-admin'],
    });
    roleRepo.find.mockResolvedValue([{ permissions: ['workspace.manage'] }]);
    messageRepo.find.mockResolvedValue([]);

    await expect(service.listMessages('ch1', 'admin')).resolves.toEqual([]);
  });

  it('returns channels projected field by field, carrying no key material at all', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
    channelRepo.find.mockResolvedValue([
      {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        isPrivate: false,
        allowedUsers: ['u1'],
      },
    ]);

    // `toEqual` and not `objectContaining`: this route used to hand back an epoch key the SERVER
    // had derived, and the assertion that says that is gone is an EXACT shape.
    await expect(service.listChannelsForUser('ws1', 'u1')).resolves.toEqual([
      {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        visibility: 'public',
        // The sidebar list now carries the same distinction the community page does: a private
        // salon an admin can SEE but has not joined comes back with `false`, which is what makes
        // the join reachable without giving them any of its content.
        viewerHasAccess: true,
      },
    ]);
  });

  // A message names the Graine session that opens it and which key of that session; the server
  // holds no seed and can invent neither. Storing one without them would produce a row that looks
  // like history and that nobody - including its own author - can ever read.
  it('rejects sendMessage that names no Graine session', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

    await expect(
      service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: '',
        messageIndex: 0,
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects sendMessage whose message index is not a real index', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

    await expect(
      service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: -1,
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts index 0, which is the first message of every session', async () => {
    const { service, channelRepo, memberRepo, messageRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
    // The accepted row fans out to the channel's audience; an unstubbed roster made both the live
    // event and the push fail with a TypeError in the log of a test that passes.
    memberRepo.find.mockResolvedValue([]);
    messageRepo.create.mockImplementation((row: any) => row);
    messageRepo.save.mockImplementation(async (row: any) => ({
      ...row,
      id: 'm1',
      createdAt: new Date(),
    }));

    await service.sendMessage('ch1', {
      senderId: 'u1',
      ciphertext: 'abc',
      nonce: 'def',
      senderSessionId: 'sess-1',
      messageIndex: 0,
      signature: SIGNATURE,
    });

    // A falsy-index guard would refuse the first message of every session, which is the one
    // message every reader is guaranteed to want.
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ senderSessionId: 'sess-1', messageIndex: 0 })
    );
  });

  // THE FAN-OUT OUTBOX (migration 093): a stored row whose process died before its broadcast is
  // finished at boot, or by a repeat of its send.
  describe('the fan-out outbox of a stored salon row (migration 093)', () => {
    const CLIENT_ID = '7b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const sql = (messageRepo: { query: jest.Mock }) =>
      messageRepo.query.mock.calls.map((call: unknown[]) => call[0] as string);
    const arrange = () => {
      const repos = makeService();
      repos.channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        isPrivate: false,
        writePolicy: 'everyone',
      });
      repos.memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
      repos.memberRepo.find.mockResolvedValue([]);
      repos.messageRepo.create.mockImplementation((row: any) => row);
      repos.messageRepo.save.mockImplementation(async (row: any) => ({
        ...row,
        id: 'm1',
        createdAt: new Date(),
      }));
      const notify = jest
        .spyOn(repos.service as any, 'notifyChannelRecipients')
        .mockResolvedValue(undefined);
      return { ...repos, notify };
    };
    const body = {
      senderId: 'u1',
      ciphertext: 'abc',
      nonce: 'def',
      senderSessionId: 'sess-1',
      messageIndex: 0,
      signature: SIGNATURE,
      mentionedUserIds: ['u2'],
    };

    it('writes the entry in the send transaction, with what the push needs', async () => {
      const { service, messageRepo } = arrange();
      await service.sendMessage('ch1', { ...body, messageId: CLIENT_ID } as never);

      expect(messageRepo.manager.transaction).toHaveBeenCalledTimes(1);
      const insert = messageRepo.query.mock.calls.find((call: unknown[]) =>
        (call[0] as string).includes('INSERT INTO channel_message_fanout')
      );
      expect(insert?.[1]).toEqual(['m1', JSON.stringify({ mentionedUserIds: ['u2'] })]);
      // After the row, inside the same transaction: both commit or neither does.
      expect(messageRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
        messageRepo.query.mock.invocationCallOrder[
          sql(messageRepo).findIndex((text) => text.includes('INSERT INTO channel_message_fanout'))
        ]
      );
    });

    it('a send without a client id is in a transaction too', async () => {
      const { service, messageRepo } = arrange();
      await service.sendMessage('ch1', body as never);
      expect(messageRepo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(sql(messageRepo).some((t) => t.includes('INSERT INTO channel_message_fanout'))).toBe(
        true
      );
    });

    it('deletes the entry once the frame and the push are handed off', async () => {
      const { service, messageRepo, redis, notify } = arrange();
      await service.sendMessage('ch1', body as never);
      await flush();

      expect(redis.publishChannelEvent).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(sql(messageRepo).some((t) => t.includes('DELETE FROM channel_message_fanout'))).toBe(
        true
      );
    });

    // The production RedisService swallows its own publish errors, so a Redis outage deletes the
    // entry: the outbox covers process death and database failures. A rejection reaching here is
    // what a failing audience read looks like; the mock rejects the publish to model it.
    it.each([
      ['the broadcast', 'publish'],
      ['the push', 'push'],
    ])('keeps the entry when %s fails', async (_label, which) => {
      const { service, messageRepo, redis, notify } = arrange();
      if (which === 'publish') redis.publishChannelEvent.mockRejectedValue(new Error('redis down'));
      else notify.mockRejectedValue(new Error('fcm down'));
      const error = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
      await service.sendMessage('ch1', body as never);
      await flush();

      expect(sql(messageRepo).some((t) => t.includes('DELETE FROM channel_message_fanout'))).toBe(
        false
      );
      expect(error).toHaveBeenCalled();
      // The OTHER half still ran: a refused push never stops the frame, nor the reverse.
      expect(which === 'publish' ? notify : redis.publishChannelEvent).toHaveBeenCalledTimes(1);
    });

    it('does not push a silent row, and still broadcasts and clears it', async () => {
      const { service, messageRepo, redis, notify } = arrange();
      await service.sendMessage('ch1', { ...body, silent: true } as never);
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(redis.publishChannelEvent).toHaveBeenCalledTimes(1);
      expect(sql(messageRepo).some((t) => t.includes('DELETE FROM channel_message_fanout'))).toBe(
        true
      );
    });

    /** The outbox as a table: one entry per id, answering the three statements the service reads. */
    const outbox = (
      repos: ReturnType<typeof arrange>,
      entries: Record<string, Record<string, unknown>>
    ) => {
      repos.messageRepo.query.mockImplementation(async (text: string, params?: unknown[]) => {
        if (text.includes('SELECT "messageId"')) {
          return Object.keys(entries).map((messageId) => ({ messageId }));
        }
        if (text.includes('SELECT payload')) {
          const entry = entries[params?.[0] as string];
          return entry ? [{ payload: entry }] : [];
        }
        if (text.includes('DELETE FROM channel_message_fanout')) {
          delete entries[params?.[0] as string];
        }
        return [];
      });
    };
    const stored = { id: 'm1', channelId: 'ch1', authorId: 'u1', content: 'abc', nonce: 'def' };

    it('boot finishes an entry a dead process left, with its own push payload', async () => {
      const repos = arrange();
      const entries = { m1: { mentionedUserIds: ['u2'], seedFrame: 'ZnJhbWU=', seedGroupId: 'g' } };
      outbox(repos, entries);
      repos.messageRepo.findOne.mockResolvedValue({
        ...stored,
        silent: false,
        createdAt: new Date(),
        metadata: {},
      });

      expect(await repos.service.drainPendingFanouts()).toBe(1);

      expect(repos.redis.publishChannelEvent).toHaveBeenCalledWith(
        'channel.message.created',
        expect.objectContaining({ channelId: 'ch1', messageId: 'm1', ciphertext: 'abc' }),
        expect.anything()
      );
      expect(repos.notify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ch1' }),
        expect.objectContaining({ id: 'm1' }),
        expect.objectContaining({
          senderId: 'u1',
          mentionedUserIds: ['u2'],
          seedFrame: 'ZnJhbWU=',
          seedGroupId: 'g',
        })
      );
      expect(entries).toEqual({});
    });

    it('settleFanouts waits for a fan-out still running, so a replaced replica does not exit on it', async () => {
      const { service, redis } = arrange();
      let release: () => void = () => {};
      redis.publishChannelEvent.mockImplementation(
        () => new Promise<void>((resolve) => (release = resolve))
      );
      await service.sendMessage('ch1', body as never);
      await flush();

      let settled = false;
      const waiting = service.settleFanouts().then(() => (settled = true));
      await flush();
      expect(settled).toBe(false);
      release();
      await waiting;
      expect(settled).toBe(true);
      // Nothing left to wait for.
      await service.settleFanouts();
    });

    it('a repeat does not drain an entry whose fan-out is running in this process', async () => {
      const repos = arrange();
      let release: () => void = () => {};
      repos.redis.publishChannelEvent.mockImplementation(
        () => new Promise<void>((resolve) => (release = resolve))
      );
      outbox(repos, { m1: {} });
      repos.messageRepo.findOne.mockResolvedValue(null);
      await repos.service.sendMessage('ch1', { ...body, messageId: CLIENT_ID } as never);
      await flush();
      expect(repos.redis.publishChannelEvent).toHaveBeenCalledTimes(1);

      // The winner's fan-out is in flight; the repeat finds the stored row and must not start a second.
      repos.messageRepo.findOne.mockResolvedValue({ ...stored, silent: false, metadata: {} });
      await repos.service.sendMessage('ch1', { ...body, messageId: CLIENT_ID } as never);
      await flush();
      expect(repos.redis.publishChannelEvent).toHaveBeenCalledTimes(1);
      release();
      await repos.service.settleFanouts();
    });

    it('boot with an empty outbox does nothing', async () => {
      const repos = arrange();
      outbox(repos, {});
      expect(await repos.service.drainPendingFanouts()).toBe(0);
      expect(repos.redis.publishChannelEvent).not.toHaveBeenCalled();
    });

    it('one entry that fails does not stop the next', async () => {
      const repos = arrange();
      const entries = { m1: {}, m2: {} };
      outbox(repos, entries);
      jest.spyOn((repos.service as any).logger, 'error').mockImplementation(() => {});
      repos.messageRepo.findOne
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce({ ...stored, id: 'm2', silent: true, metadata: {} });

      expect(await repos.service.drainPendingFanouts()).toBe(1);
      expect(Object.keys(entries)).toEqual(['m1']);
    });

    it('a repeat of a send drains its own entry at once, and writes nothing', async () => {
      const repos = arrange();
      const entries = { m1: { mentionedUserIds: ['u2'] } };
      outbox(repos, entries);
      repos.messageRepo.findOne.mockResolvedValue({
        ...stored,
        silent: false,
        createdAt: new Date(),
        metadata: {},
      });

      const answer = await repos.service.sendMessage('ch1', {
        ...body,
        messageId: CLIENT_ID,
      } as never);
      await flush();

      expect(answer.id).toBe('m1');
      expect(repos.messageRepo.save).not.toHaveBeenCalled();
      expect(repos.redis.publishChannelEvent).toHaveBeenCalledTimes(1);
      expect(entries).toEqual({});
    });

    it('a repeat of a send that completed finds no entry and publishes nothing', async () => {
      const repos = arrange();
      outbox(repos, {});
      repos.messageRepo.findOne.mockResolvedValue({ ...stored, silent: false, metadata: {} });

      await repos.service.sendMessage('ch1', { ...body, messageId: CLIENT_ID } as never);
      await flush();

      expect(repos.redis.publishChannelEvent).not.toHaveBeenCalled();
    });
  });

  describe('the seed frame a message carries (channel-encryption section 19)', () => {
    const FRAME = { seedFrame: 'ZnJhbWU=', seedGroupId: 'dist-ws1' };
    const send = (extra: Record<string, unknown>, channel: Record<string, unknown> = {}) => {
      const repos = makeService();
      repos.channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        isPrivate: false,
        distributionGroupId: 'dist-salon',
        ...channel,
      });
      repos.memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
      repos.memberRepo.find.mockResolvedValue([]);
      repos.workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', distributionGroupId: 'dist-ws1' });
      repos.messageRepo.create.mockImplementation((row: any) => row);
      repos.messageRepo.save.mockImplementation(async (row: any) => ({
        ...row,
        id: 'm1',
        createdAt: new Date(),
      }));
      const done = repos.service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: 0,
        signature: SIGNATURE,
        ...extra,
      } as never);
      return { ...repos, done };
    };
    const code = async (p: Promise<unknown>) =>
      (
        (await p.then(
          () => null,
          (e: BadRequestException) => e.getResponse()
        )) as { code?: string } | null
      )?.code;

    it('accepts the community key group for a public salon, and never stores the frame', async () => {
      const { done, messageRepo, redis } = send(FRAME);
      await done;
      // The live event is published off the response path; let it run.
      await new Promise((resolve) => setImmediate(resolve));

      // Nor in the live event: a device with the app open has the seed from the key group already.
      expect(redis.publishChannelEvent).toHaveBeenCalled();
      expect(JSON.stringify(redis.publishChannelEvent.mock.calls)).not.toContain(FRAME.seedFrame);

      const row = messageRepo.create.mock.calls[0][0] as Record<string, unknown>;
      expect(row.seedFrame).toBeUndefined();
      expect(row.seedGroupId).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(FRAME.seedFrame);
    });

    it('accepts the salon own key group for a private salon', async () => {
      const { done } = send(
        { ...FRAME, seedGroupId: 'dist-salon' },
        { isPrivate: true, allowedUsers: ['u1'] }
      );
      await expect(done).resolves.toBeDefined();
    });

    it('accepts a message with no frame at all - a sender older than the rule', async () => {
      await expect(send({}).done).resolves.toBeDefined();
    });

    it('refuses a group that is not the salon key group, with a typed code', async () => {
      // A private salon whose sender still seals on the community group: its seed went to everyone.
      const { done, messageRepo } = send(FRAME, { isPrivate: true, allowedUsers: ['u1'] });
      expect(await code(done)).toBe('CHANNEL_SEED_FRAME_GROUP_MISMATCH');
      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      ['a frame without its group', { seedFrame: FRAME.seedFrame }],
      ['a group without its frame', { seedGroupId: FRAME.seedGroupId }],
      ['a frame that is not base64', { ...FRAME, seedFrame: 'not base64!' }],
      ['a frame over the cap', { ...FRAME, seedFrame: 'A'.repeat(2052) }],
    ])('refuses %s', async (_label, extra) => {
      const { done, messageRepo } = send(extra);
      expect(await code(done)).toBe('CHANNEL_SEED_FRAME_INVALID');
      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('Graine v2 on the server: a signature relayed, one row per key (migration 065)', () => {
    const send = (extra: Record<string, unknown>, save?: (row: any) => Promise<unknown>) => {
      const repos = makeService();
      repos.channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        isPrivate: false,
      });
      repos.memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
      repos.memberRepo.find.mockResolvedValue([]);
      repos.messageRepo.create.mockImplementation((row: any) => row);
      repos.messageRepo.save.mockImplementation(
        save ?? (async (row: any) => ({ ...row, id: 'm1', createdAt: new Date() }))
      );
      const done = repos.service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: 3,
        signature: SIGNATURE,
        ...extra,
      } as never);
      return { ...repos, done };
    };
    const code = async (p: Promise<unknown>) =>
      (
        (await p.then(
          () => null,
          (e: BadRequestException) => e.getResponse()
        )) as { code?: string } | null
      )?.code;

    it('stores the signature and relays it in the live event', async () => {
      const { done, messageRepo, redis } = send({ signature: SIGNATURE });
      await done;
      await new Promise((resolve) => setImmediate(resolve));

      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ signature: SIGNATURE })
      );
      expect(redis.publishChannelEvent).toHaveBeenCalledWith(
        'channel.message.created',
        expect.objectContaining({ signature: SIGNATURE }),
        expect.anything()
      );
    });

    it.each([
      ['absent', { signature: undefined }],
      ['null', { signature: null }],
      ['absent on a silent row (a reaction, an edit)', { signature: undefined, silent: true }],
      [
        'absent on a poll',
        {
          signature: undefined,
          poll: { optionIds: ['a', 'b'], multipleChoice: false, endsAt: null },
        },
      ],
    ])(
      'REFUSES a row whose signature is %s with CHANNEL_SIGNATURE_REQUIRED, at ERROR, storing and sending nothing',
      async (_label, extra) => {
        const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        try {
          const { done, messageRepo, redis } = send(extra);
          expect(await code(done)).toBe(CHANNEL_SIGNATURE_REQUIRED);
          await new Promise((resolve) => setImmediate(resolve));
          expect(messageRepo.save).not.toHaveBeenCalled();
          expect(redis.publishChannelEvent).not.toHaveBeenCalled();
          // A line that ACCUSES: no admitted client sends this.
          expect(
            logError.mock.calls.some((call) =>
              String(call[0]).includes('[CHANNEL_SIGNATURE] REFUSED unsigned row')
            )
          ).toBe(true);
        } finally {
          logError.mockRestore();
        }
      }
    );

    it('still answers a non-member 403 before reading the signature - authorization comes first', async () => {
      const repos = makeService();
      repos.channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        isPrivate: false,
      });
      repos.memberRepo.findOne.mockResolvedValue(null);
      await expect(
        repos.service.sendMessage('ch1', {
          senderId: 'stranger',
          ciphertext: 'abc',
          nonce: 'def',
          senderSessionId: 'sess-1',
          messageIndex: 0,
        })
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    /**
     * THE FLOOR BOUNDARY, as the two releases on either side of it put a row on the wire.
     *
     * The bodies are the exact field sets `sendEncryptedChannelMessage` posts at the tags: `v1.0.2`
     * (the last release below `minClientVersion` 1.0.3) sends no `signature`; `v1.0.3` (the G2-5
     * writer, the floor) sends one on every row. Each shape a current client posts - text with its
     * seed frame, a silent reaction or edit, a poll, a system notice, a mention - is accepted signed.
     */
    describe('the floor boundary: what v1.0.2 and v1.0.3 put on the wire', () => {
      const FRAME = { seedFrame: 'ZnJhbWU=', seedGroupId: 'dist-ws1' };
      const sendAs = (body: Record<string, unknown>) => {
        const repos = makeService();
        repos.channelRepo.findOne.mockResolvedValue({
          id: 'ch1',
          workspaceId: 'ws1',
          isPrivate: false,
        });
        repos.memberRepo.findOne.mockResolvedValue({
          workspaceId: 'ws1',
          userId: 'u1',
          roleIds: [],
        });
        repos.memberRepo.find.mockResolvedValue([]);
        repos.workspaceRepo.findOne.mockResolvedValue({
          id: 'ws1',
          distributionGroupId: 'dist-ws1',
        });
        repos.messageRepo.create.mockImplementation((row: any) => row);
        repos.messageRepo.save.mockImplementation(async (row: any) => ({
          ...row,
          id: 'm1',
          createdAt: new Date(),
        }));
        const done = repos.service.sendMessage('ch1', { senderId: 'u1', ...body } as never);
        return { ...repos, done };
      };
      const sealed = {
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: 4,
      };
      const shapes: [string, Record<string, unknown>][] = [
        ['a text message with its seed frame', { messageId: CLIENT_ID, ...FRAME }],
        ['a silent reaction or edit', { silent: true }],
        [
          'a poll',
          { poll: { optionIds: ['a', 'b'], multipleChoice: true, endsAt: null }, ...FRAME },
        ],
        ['a system notice (no client id)', { ...FRAME }],
        ['a message with mentions', { mentionedUserIds: ['u2'], ...FRAME }],
      ];

      it.each(shapes)('v1.0.3 (the floor): %s, signed, is ACCEPTED', async (_label, extra) => {
        const { done, messageRepo } = sendAs({ ...sealed, signature: SIGNATURE, ...extra });
        await expect(done).resolves.toBeDefined();
        expect(messageRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ signature: SIGNATURE })
        );
      });

      it.each(shapes)(
        'v1.0.2 (below the floor): %s, unsigned, is REFUSED',
        async (_label, extra) => {
          const logError = jest
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
          try {
            const { done, messageRepo } = sendAs({ ...sealed, ...extra });
            expect(await code(done)).toBe(CHANNEL_SIGNATURE_REQUIRED);
            expect(messageRepo.save).not.toHaveBeenCalled();
          } finally {
            logError.mockRestore();
          }
        }
      );
    });

    it.each([
      ['a signature of another length', Buffer.alloc(63, 7).toString('base64')],
      ['a signature that is not base64', '!'.repeat(88)],
      ['a signature that is not a string', 42],
    ])('refuses %s with a typed code, storing nothing', async (_label, signature) => {
      const { done, messageRepo } = send({ signature });
      expect(await code(done)).toBe('CHANNEL_SIGNATURE_INVALID');
      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it('answers a second row under one message key with a typed 409, never a 500', async () => {
      const { done } = send({}, async () => {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      });
      const error = await done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(((error as ConflictException).getResponse() as { code: string }).code).toBe(
        'CHANNEL_MESSAGE_KEY_REUSED'
      );
    });

    it('lets any other save failure through untouched', async () => {
      const { done } = send({}, async () => {
        throw new Error('connection reset');
      });
      await expect(done).rejects.toThrow('connection reset');
    });
  });

  /**
   * WP-OFF-3: a send repeated after a lost answer is answered with the row it already made. The
   * client's durable queue re-posts a salon message whose first POST got no answer; without this the
   * repeat of a POST that DID land wrote a second row (a duplicate on every member's screen).
   */
  describe('a repeated send is answered with its stored row (migration 090)', () => {
    const STORED = {
      id: 'm-first',
      channelId: 'ch1',
      authorId: 'u1',
      clientMessageId: CLIENT_ID,
      createdAt: new Date(1_000),
    };
    const send = (
      extra: Record<string, unknown>,
      opts: { stored?: unknown; save?: (row: any) => Promise<unknown> } = {}
    ) => {
      const repos = makeService();
      repos.channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        isPrivate: false,
      });
      repos.memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
      repos.memberRepo.find.mockResolvedValue([]);
      repos.messageRepo.findOne.mockResolvedValue(opts.stored ?? null);
      repos.messageRepo.create.mockImplementation((row: any) => row);
      repos.messageRepo.save.mockImplementation(
        opts.save ?? (async (row: any) => ({ ...row, id: 'm-new', createdAt: new Date(2_000) }))
      );
      const done = repos.service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: 3,
        signature: SIGNATURE,
        ...extra,
      } as never);
      return { ...repos, done };
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('stores the client id with a new row', async () => {
      const { done, messageRepo } = send({ messageId: CLIENT_ID });
      await expect(done).resolves.toMatchObject({ id: 'm-new' });
      expect(messageRepo.findOne).toHaveBeenCalledWith({
        where: { channelId: 'ch1', authorId: 'u1', clientMessageId: CLIENT_ID },
      });
      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ clientMessageId: CLIENT_ID })
      );
    });

    it('answers a repeat with the STORED row and writes, publishes and pushes nothing', async () => {
      const { done, messageRepo, redis } = send(
        // A repeat sealed anew (the roster moved): another session, the same client id.
        { messageId: CLIENT_ID, senderSessionId: 'sess-2', messageIndex: 0 },
        { stored: STORED }
      );
      await expect(done).resolves.toBe(STORED);
      await settle();
      expect(messageRepo.save).not.toHaveBeenCalled();
      expect(redis.publishChannelEvent).not.toHaveBeenCalled();
    });

    it('echoes the client id in the answer, even when the read did not select it', async () => {
      const { clientMessageId: _unselected, ...read } = STORED;
      const { done } = send({ messageId: CLIENT_ID }, { stored: { ...read } });
      await expect(done).resolves.toMatchObject({ id: 'm-first', clientMessageId: CLIENT_ID });
      const fresh = send({ messageId: CLIENT_ID });
      await expect(fresh.done).resolves.toMatchObject({ clientMessageId: CLIENT_ID });
    });

    it('refuses a repeat of a DELETED message with a typed 410, writing nothing', async () => {
      const repos = send({ messageId: CLIENT_ID });
      repos.messageRepo.query
        .mockResolvedValueOnce([]) // the client id's lock
        .mockResolvedValueOnce([{ '?column?': 1 }]); // its tombstone
      const error = await repos.done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoneException);
      expect(((error as GoneException).getResponse() as { code?: string }).code).toBe(
        'CHANNEL_MESSAGE_DELETED'
      );
      // The check runs UNDER the lock a delete takes, in the transaction that would insert: a check
      // made before it let a delete fall between the check and the insert, and re-post the row.
      const [[lockSql, lockParams], [checkSql, checkParams]] = repos.messageRepo.query.mock.calls;
      expect(lockSql).toContain(clientIdLockSql('$1', '$2', '$3'));
      expect(lockParams).toEqual(['u1', 'ch1', CLIENT_ID]);
      expect(checkSql).toContain('channel_message_client_tombstones');
      expect(checkParams).toEqual(['u1', 'ch1', CLIENT_ID]);
      expect(repos.messageRepo.manager.transaction).toHaveBeenCalledTimes(1);
      await settle();
      expect(repos.messageRepo.save).not.toHaveBeenCalled();
      expect(repos.redis.publishChannelEvent).not.toHaveBeenCalled();
    });

    it('reads the id in either case: the stored key is lower case', async () => {
      const { done, messageRepo } = send(
        { messageId: CLIENT_ID.toUpperCase() },
        { stored: STORED }
      );
      await expect(done).resolves.toBe(STORED);
      expect(messageRepo.findOne).toHaveBeenCalledWith({
        where: { channelId: 'ch1', authorId: 'u1', clientMessageId: CLIENT_ID },
      });
    });

    it('answers the loser of two racing repeats with the winner row, never a 409', async () => {
      const repos = send(
        { messageId: CLIENT_ID },
        {
          save: async () => {
            throw Object.assign(new Error('duplicate key value'), { code: '23505' });
          },
        }
      );
      // Absent at the lookup, present once the insert collided.
      repos.messageRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(STORED);
      await expect(repos.done).resolves.toBe(STORED);
      await settle();
      expect(repos.redis.publishChannelEvent).not.toHaveBeenCalled();
    });

    it('still answers a key reused under ANOTHER client id with the typed 409', async () => {
      const repos = send(
        { messageId: CLIENT_ID },
        {
          save: async () => {
            throw Object.assign(new Error('duplicate key value'), { code: '23505' });
          },
        }
      );
      const error = await repos.done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
    });

    it('leaves a row with no client id alone: a silent row is never looked up', async () => {
      const { done, messageRepo } = send({ silent: true });
      await done;
      expect(messageRepo.findOne).not.toHaveBeenCalled();
      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ clientMessageId: null })
      );
    });

    it.each([
      ['a string that is not a UUID', 'client-1'],
      ['a number', 42],
      ['an empty string', ''],
    ])('refuses %s as the client id, storing nothing', async (_label, messageId) => {
      const { done, messageRepo } = send({ messageId });
      const response = await done.then(
        () => null,
        (e: BadRequestException) => e.getResponse() as { code?: string }
      );
      expect(response?.code).toBe('CHANNEL_CLIENT_MESSAGE_ID_INVALID');
      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  it('rejects sendMessage from a plain member when writePolicy is admins', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      writePolicy: 'admins',
      keyVersion: 3,
    });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'u1',
      roleIds: ['r-member'],
    });
    roleRepo.find.mockResolvedValue([{ permissions: ['member.invite'] }]);

    await expect(
      service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        senderSessionId: 'sess-1',
        messageIndex: 0,
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getNotificationLevel defaults to all and returns the stored value', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({ id: 'ch1', workspaceId: 'ws1', isPrivate: false });

    memberRepo.findOne.mockResolvedValueOnce({ workspaceId: 'ws1', userId: 'u1', notifLevels: {} });
    await expect(service.getNotificationLevel('ch1', 'u1')).resolves.toEqual({
      channelId: 'ch1',
      level: 'all',
    });

    memberRepo.findOne.mockResolvedValueOnce({
      workspaceId: 'ws1',
      userId: 'u1',
      notifLevels: { ch1: 'mentions' },
    });
    await expect(service.getNotificationLevel('ch1', 'u1')).resolves.toEqual({
      channelId: 'ch1',
      level: 'mentions',
    });
  });

  /**
   * The one UPDATE `setNotificationLevel` makes, recorded: its key, its level and the row it names.
   * It answers `affected` rows, so a case can make the membership gone between read and write.
   */
  function notifLevelUpdate(memberRepo: Record<string, unknown>, affected = 1) {
    const seen: { params: Record<string, unknown>; set?: Record<string, unknown> } = { params: {} };
    const builder: Record<string, unknown> = {
      update: jest.fn(() => builder),
      set: jest.fn((s: Record<string, unknown>) => {
        seen.set = s;
        return builder;
      }),
      where: jest.fn((_sql: string, p: Record<string, unknown>) => {
        Object.assign(seen.params, p);
        return builder;
      }),
      setParameters: jest.fn((p: Record<string, unknown>) => {
        Object.assign(seen.params, p);
        return builder;
      }),
      execute: jest.fn(() => Promise.resolve({ affected })),
    };
    memberRepo.createQueryBuilder = jest.fn(() => builder);
    return seen;
  }

  it('setNotificationLevel persists the level and rejects non-members', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({ id: 'ch1', workspaceId: 'ws1', isPrivate: false });
    const seen = notifLevelUpdate(memberRepo);

    memberRepo.findOne.mockResolvedValueOnce({ id: 'm1', workspaceId: 'ws1', userId: 'u1' });
    await expect(service.setNotificationLevel('ch1', 'u1', 'none')).resolves.toEqual({
      channelId: 'ch1',
      level: 'none',
    });
    // One key merged into the stored map, on the row read - never a save of that row.
    expect(seen.params).toEqual({ memberId: 'm1', channelKey: 'ch1', level: 'none' });
    expect(memberRepo.save).not.toHaveBeenCalled();

    memberRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.setNotificationLevel('ch1', 'uX', 'all')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('setNotificationLevel refuses a membership gone between its read and its write', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({ id: 'ch1', workspaceId: 'ws1', isPrivate: false });
    notifLevelUpdate(memberRepo, 0);
    memberRepo.findOne.mockResolvedValueOnce({ id: 'm1', workspaceId: 'ws1', userId: 'u1' });

    await expect(service.setNotificationLevel('ch1', 'u1', 'none')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(memberRepo.save).not.toHaveBeenCalled();
  });

  it('notifyChannelRecipients honours per-channel level and mentions, skipping the sender', async () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    const prevFetch = global.fetch;
    process.env.INTERNAL_SECRET = 'test-secret';
    const fetchMock = jest.fn((_url: string, _init: { body: string }) =>
      Promise.resolve({ ok: true } as Response)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      // The service caches INTERNAL_SECRET at construction time, so build it after setting the env.
      const { service, memberRepo, workspaceRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', name: 'Campagne de test' });
      const channel = {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        isPrivate: false,
        allowedUsers: [] as string[],
        keyVersion: 1,
      };
      memberRepo.find.mockResolvedValue([
        { userId: 'u1', roleIds: [], notifLevels: {} }, // sender - skipped
        { userId: 'u2', roleIds: [], notifLevels: {} }, // all (default) -> push
        { userId: 'u3', roleIds: [], notifLevels: { ch1: 'none' } }, // none -> skip
        { userId: 'u4', roleIds: [], notifLevels: { ch1: 'mentions' } }, // mentions, not mentioned -> skip
        { userId: 'u5', roleIds: [], notifLevels: { ch1: 'mentions' } }, // mentions, mentioned -> push
      ]);

      await (
        service as unknown as {
          notifyChannelRecipients: (c: unknown, m: unknown, i: unknown) => Promise<void>;
        }
      ).notifyChannelRecipients(
        channel,
        {
          id: 'm1',
          senderSessionId: 'sess-1',
          messageIndex: 4,
          createdAt: new Date(1758499191859),
        },
        {
          senderId: 'u1',
          ciphertext: 'c',
          nonce: 'n',
          senderSessionId: 'sess-1',
          messageIndex: 4,
          mentionedUserIds: ['u5'],
          seedFrame: 'ZnJhbWU=',
          seedGroupId: 'dist-ws1',
          signature: 'c2lnbmF0dXJl',
        }
      );

      const sent = fetchMock.mock.calls
        .map(
          (call) =>
            JSON.parse(call[1].body) as {
              userId: string;
              title: string;
              data: Record<string, string>;
              inline: Record<string, string>;
            }
        )
        .sort((a, b) => a.userId.localeCompare(b.userId));
      expect(sent.map((s) => s.userId)).toEqual(['u2', 'u5']);

      // The mention travels per recipient: only u5 was named, and the device routes its own
      // notification channel on this field alone (it cannot read the ciphertext to find out).
      expect(sent[0].data.mentioned).toBe('false');
      expect(sent[1].data.mentioned).toBe('true');

      // And the payload carries nothing a client does not read: workspaceId and messageId were
      // dropped once measured dead on all three clients. A field nobody reads still costs room
      // under FCM's 4 KB cap, which the inlined ciphertext competes for - which is why this asserts
      // the WHOLE set rather than the fields it cares about, so a field added without a reader
      // fails here.
      expect(Object.keys(sent[0].data).sort()).toEqual([
        'channelId',
        'channelName',
        'createdAt',
        'mentioned',
        'messageIndex',
        'nonce',
        'senderId',
        'senderSessionId',
        'type',
        'workspaceName',
      ]);

      // The session and the index derive the key. `keyVersion` used to sit here and named an
      // epoch the SERVER derived; no device can do anything with it now, so it is gone rather
      // than left on the wire looking like a contract.
      expect(sent[0].data.senderSessionId).toBe('sess-1');

      // THE CIPHERTEXT AND ITS SEED FRAME ARE ONE GROUP, handed over apart from the fields every push
      // carries: chat-delivery inlines the whole of it or none of it, per device, on the payload it
      // really sends (channel-encryption section 19). A frame without its message opens nothing.
      // The v2 signature joins the group: a native reader refuses a v2 row without it (section 21.5).
      expect(sent[0].inline).toEqual({
        ciphertext: 'c',
        seedFrame: 'ZnJhbWU=',
        seedGroupId: 'dist-ws1',
        signature: 'c2lnbmF0dXJl',
      });
      expect(sent[0].data.messageIndex).toBe('4');

      // THE INSTANT IS THE STORED COLUMN, AS MILLISECONDS, AND IT IS WHY THE FIELD EXISTS. Android
      // has one notification builder with two triggers - this push and the socket frame - and it
      // recognises one message by comparing that number. The socket half reads the SAME
      // `createdAt` off `channel.message.created`, so the comparison is exact; a re-derivation
      // here (a wall clock, a rounding, a seconds-precision string) would make one message two
      // lines in the shade, which is the defect the field was added to close.
      expect(sent[0].data.createdAt).toBe('1758499191859');

      // The community is named on the wire because no client can turn a workspace uuid into one,
      // and the title this endpoint carries is the APNs alert - what an iPhone shows when the
      // Notification Service Extension cannot run, so it has to read like what the extension writes.
      expect(sent[0].data.workspaceName).toBe('Campagne de test');
      expect(sent[0].title).toBe('Campagne de test - #general');
    } finally {
      process.env.INTERNAL_SECRET = prevSecret;
      global.fetch = prevFetch;
    }
  });

  it('a channel whose workspace row is gone still notifies, loudly and without the community', async () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    const prevFetch = global.fetch;
    process.env.INTERNAL_SECRET = 'test-secret';
    const fetchMock = jest.fn((_url: string, _init: { body: string }) =>
      Promise.resolve({ ok: true } as Response)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service, memberRepo, workspaceRepo } = makeService();
      // A channel always has a workspace, so a missing row is a data-integrity fault. The push must
      // still go out - degraded to `#<salon>`, exactly the title it had before this field existed -
      // and the log has to ACCUSE, or the community would just quietly stop appearing.
      workspaceRepo.findOne.mockResolvedValue(null);
      memberRepo.find.mockResolvedValue([{ userId: 'u2', roleIds: [], notifLevels: {} }]);

      await (
        service as unknown as {
          notifyChannelRecipients: (c: unknown, m: unknown, i: unknown) => Promise<void>;
        }
      ).notifyChannelRecipients(
        {
          id: 'ch1',
          workspaceId: 'ws1',
          name: 'general',
          isPrivate: false,
          allowedUsers: [] as string[],
          keyVersion: 1,
        },
        { id: 'm1', keyVersion: 1, createdAt: new Date() },
        { senderId: 'u1', ciphertext: 'c', nonce: 'n' }
      );

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body) as {
        title: string;
        data: Record<string, string>;
      };
      expect(sent.title).toBe('#general');
      expect(sent.data.workspaceName).toBe('');
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('[CHANNEL_PUSH] workspace=ws1')
      );
    } finally {
      logError.mockRestore();
      process.env.INTERNAL_SECRET = prevSecret;
      global.fetch = prevFetch;
    }
  });

  it('markChannelRead rejects a non-member', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({ id: 'ch1', workspaceId: 'ws1', isPrivate: false });
    memberRepo.findOne.mockResolvedValue(null);
    await expect(service.markChannelRead('ch1', 'uX')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('markChannelRead fans out a silent channel_read push to the caller', async () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    const prevFetch = global.fetch;
    process.env.INTERNAL_SECRET = 'test-secret';
    const fetchMock = jest.fn((_url: string, _init: { body: string }) =>
      Promise.resolve({ ok: true } as Response)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { service, channelRepo, memberRepo } = makeService();
      channelRepo.findOne.mockResolvedValue({
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        isPrivate: false,
        allowedUsers: [] as string[],
      });
      memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

      await service.markChannelRead('ch1', 'u1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.userId).toBe('u1');
      expect(payload.data).toMatchObject({
        type: 'channel_read',
        channelId: 'ch1',
        senderId: 'u1',
      });
    } finally {
      process.env.INTERNAL_SECRET = prevSecret;
      global.fetch = prevFetch;
    }
  });

  it('setNotificationLevel keys the map by the DB-canonical channel.id, not the raw param (no property injection)', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    // The client sends a hostile channelId, but the row is looked up and its
    // canonical id is what must be used as the object key.
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
    });
    memberRepo.findOne.mockResolvedValue({
      id: 'm1',
      workspaceId: 'ws1',
      userId: 'u1',
      roleIds: [],
    });
    const seen = notifLevelUpdate(memberRepo);

    await service.setNotificationLevel('__proto__', 'u1', 'none');

    // The stored key is the canonical channel.id, never the raw '__proto__' param - and it is a
    // bound parameter of the SQL, never an object property name.
    expect(seen.params.channelKey).toBe('ch1');
    expect(Object.values(seen.params)).not.toContain('__proto__');
  });

  /** Wires the repos so `getWorkspaceBySlug('team')` resolves against one workspace. */
  function arrangeWorkspaceBySlug(
    repos: ReturnType<typeof makeService>,
    members: Array<{ userId: string; roleIds?: string[] }>,
    channels: Array<Partial<Channel>>
  ) {
    repos.workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', slug: 'team', name: 'Team' });
    repos.memberRepo.find.mockResolvedValue(members.map((m) => ({ workspaceId: 'ws1', ...m })));
    repos.roleRepo.find.mockResolvedValue([]);
    repos.channelRepo.find.mockResolvedValue(channels);
  }

  it('getWorkspaceBySlug never returns a channel masterSecret', async () => {
    const repos = makeService();
    arrangeWorkspaceBySlug(
      repos,
      [{ userId: 'u1', roleIds: [] }],
      [
        {
          id: 'ch1',
          workspaceId: 'ws1',
          name: 'general',
          isPrivate: false,
          allowedUsers: ['u1', 'u2'],
        },
      ]
    );

    const result = await repos.service.getWorkspaceBySlug('team', 'u1');

    // The projection is field by field, never the entity. `allowedUsers` is the private-channel
    // roster and stands here for every column the contract does not name: spreading the row is what
    // once handed `masterSecret` - the HKDF root of every epoch key - to the caller.
    expect(JSON.stringify(result)).not.toContain('allowedUsers');
    expect(result.channels).toEqual([
      {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        visibility: 'public',
        writePolicy: 'everyone',
        // Carried since 2026-08-19, because the list now includes private salons an admin can SEE
        // but has not joined - and the client must be able to tell "open it" from "join it first".
        viewerHasAccess: true,
        // Carried since 2026-08-20: the write policy is enforced per message on the server, and a
        // client that never learned of it offered a composer every post from was refused.
        viewerCanWrite: true,
      },
    ]);
  });

  it('getWorkspaceBySlug refuses a caller who is not a member', async () => {
    const repos = makeService();
    arrangeWorkspaceBySlug(repos, [{ userId: 'u1' }], []);

    // A slug is public knowledge - every invite preview hands one out.
    await expect(repos.service.getWorkspaceBySlug('team', 'intruder')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('getWorkspaceBySlug hides a private channel the member may not read', async () => {
    const repos = makeService();
    arrangeWorkspaceBySlug(
      repos,
      [{ userId: 'u1', roleIds: [] }],
      [
        { id: 'ch1', workspaceId: 'ws1', name: 'general', isPrivate: false },
        {
          id: 'ch2',
          workspaceId: 'ws1',
          name: 'staff',
          isPrivate: true,
          allowedUsers: [],
        },
      ]
    );
    // canAccessChannel falls back to the MANAGE_WORKSPACE check for a private channel.
    repos.memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

    const result = await repos.service.getWorkspaceBySlug('team', 'u1');

    expect(result.channels.map((c) => c.name)).toEqual(['general']);
  });

  it('listWorkspacesForUser flags viewerCanManage from the MANAGE_WORKSPACE permission', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    memberRepo.find.mockResolvedValue([
      { workspaceId: 'ws1', userId: 'u1', roleIds: ['r-admin'] },
      { workspaceId: 'ws2', userId: 'u1', roleIds: ['r-member'] },
    ]);
    workspaceRepo.find.mockResolvedValue([
      { id: 'ws1', name: 'Admin WS' },
      { id: 'ws2', name: 'Member WS' },
    ]);
    roleRepo.find.mockResolvedValue([
      { id: 'r-admin', permissions: ['workspace.manage'] },
      { id: 'r-member', permissions: ['member.invite'] },
    ]);

    const result = await service.listWorkspacesForUser('u1');

    expect(result).toEqual([
      expect.objectContaining({ id: 'ws1', viewerCanManage: true }),
      expect.objectContaining({ id: 'ws2', viewerCanManage: false }),
    ]);
  });

  // The salon controls read this flag, and `channel.manage` alone is enough for every salon write -
  // so it must not be `viewerCanManage` under another name.
  it('listWorkspacesForUser flags viewerCanManageChannels from channel.manage OR workspace.manage', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    memberRepo.find.mockResolvedValue([
      { workspaceId: 'ws1', userId: 'u1', roleIds: ['r-admin'] },
      { workspaceId: 'ws2', userId: 'u1', roleIds: ['r-salons'] },
      { workspaceId: 'ws3', userId: 'u1', roleIds: ['r-member'] },
    ]);
    workspaceRepo.find.mockResolvedValue([
      { id: 'ws1', name: 'Admin WS' },
      { id: 'ws2', name: 'Salon manager WS' },
      { id: 'ws3', name: 'Member WS' },
    ]);
    roleRepo.find.mockResolvedValue([
      { id: 'r-admin', permissions: ['workspace.manage'] },
      { id: 'r-salons', permissions: ['channel.manage'] },
      { id: 'r-member', permissions: ['member.invite'] },
    ]);

    const result = await service.listWorkspacesForUser('u1');

    expect(result).toEqual([
      expect.objectContaining({ id: 'ws1', viewerCanManage: true, viewerCanManageChannels: true }),
      expect.objectContaining({ id: 'ws2', viewerCanManage: false, viewerCanManageChannels: true }),
      expect.objectContaining({
        id: 'ws3',
        viewerCanManage: false,
        viewerCanManageChannels: false,
      }),
    ]);
  });

  it('listWorkspacesForUser defaults viewerCanManage to false when the user holds no roles', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    memberRepo.find.mockResolvedValue([{ workspaceId: 'ws1', userId: 'u1', roleIds: [] }]);
    workspaceRepo.find.mockResolvedValue([{ id: 'ws1', name: 'WS' }]);

    const result = await service.listWorkspacesForUser('u1');

    // No roleIds -> no role lookup needed, and the workspace is not manageable.
    expect(roleRepo.find).not.toHaveBeenCalled();
    expect(result).toEqual([expect.objectContaining({ id: 'ws1', viewerCanManage: false })]);
  });

  it('listWorkspacesForUser returns an empty list for a user with no memberships', async () => {
    const { service, memberRepo, workspaceRepo } = makeService();
    memberRepo.find.mockResolvedValue([]);

    await expect(service.listWorkspacesForUser('u1')).resolves.toEqual([]);
    expect(workspaceRepo.find).not.toHaveBeenCalled();
  });
  /** Wires a private channel owned by ws1, its roles, and its full workspace roster. */
  function arrangePrivateChannelRoster(repos: {
    channelRepo: { findOne: jest.Mock };
    memberRepo: { findOne: jest.Mock; find: jest.Mock };
    roleRepo: { find: jest.Mock };
  }) {
    repos.channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: true,
      // `boss` is listed because they JOINED, not because they are an admin - since 2026-08-19
      // being an admin grants no access to a private salon at all.
      allowedUsers: ['guest', 'boss'],
    });
    repos.memberRepo.findOne.mockImplementation(({ where }: { where: { userId: string } }) =>
      Promise.resolve({ workspaceId: 'ws1', userId: where.userId, roleIds: ['r-admin'] })
    );
    repos.memberRepo.find.mockResolvedValue([
      { id: 'm1', userId: 'boss', roleIds: ['r-admin'], createdAt: 'now' },
      { id: 'm2', userId: 'guest', roleIds: ['r-member'], createdAt: 'now' },
      { id: 'm3', userId: 'outsider', roleIds: ['r-member'], createdAt: 'now' },
    ]);
    repos.roleRepo.find.mockResolvedValue([
      { id: 'r-admin', name: 'Administrateur', priority: 10, permissions: ['workspace.manage'] },
      { id: 'r-member', name: 'Membre', priority: 1, permissions: [] },
    ]);
  }

  it('listChannelMembers scopes a private channel to exactly its allowed users', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });

    const members = await service.listChannelMembers('ch1', 'boss');

    // `outsider` is in the community but cannot read the channel, so it is not in its roster.
    expect(members.map((m) => m.userId).sort((a, b) => a.localeCompare(b))).toEqual([
      'boss',
      'guest',
    ]);
  });

  it('listChannelMembers with scope=workspace still returns the whole community roster', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });

    // The settings picker grants access to people who are not in the channel yet.
    const members = await service.listChannelMembers('ch1', 'boss', 'workspace');

    expect(members.map((m) => m.userId).sort((a, b) => a.localeCompare(b))).toEqual([
      'boss',
      'guest',
      'outsider',
    ]);
  });

  it('listChannelMembers marks who is online only when presence is asked for', async () => {
    const { service, channelRepo, memberRepo, roleRepo, redis } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });
    redis.onlineDevicesByUser.mockResolvedValue(new Map([['guest', ['tauri-g', 'web-g']]]));

    const plain = await service.listChannelMembers('ch1', 'boss');
    // The lists the UI draws never pay the keyspace scan.
    expect(redis.onlineDevicesByUser).not.toHaveBeenCalled();
    expect(plain.every((m) => !('online' in m))).toBe(true);

    const marked = await service.listChannelMembers('ch1', 'boss', 'channel', true);
    expect(marked.map((m) => [m.userId, 'online' in m && m.online])).toEqual([
      ['boss', false],
      ['guest', true],
    ]);
  });

  it('names the online DEVICES of each member, which a seed request elects its answerer from', async () => {
    // Since 1.2.5 the requester names ONE device of the member it elects (channel-encryption
    // section 23); a per-user flag cannot say which.
    const { service, channelRepo, memberRepo, roleRepo, redis } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });
    redis.onlineDevicesByUser.mockResolvedValue(new Map([['guest', ['tauri-g', 'web-g']]]));

    const marked = await service.listChannelMembers('ch1', 'boss', 'channel', true);

    expect(marked.map((m) => [m.userId, 'onlineDevices' in m && m.onlineDevices])).toEqual([
      ['boss', []],
      ['guest', ['tauri-g', 'web-g']],
    ]);
  });

  it('listWorkspaceMembers marks who is online when presence is asked for', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo, redis } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'boss', roleIds: [] });
    memberRepo.find.mockResolvedValue([
      { id: 'm1', userId: 'boss', roleIds: [], createdAt: 'now' },
      { id: 'm2', userId: 'Guest', roleIds: [], createdAt: 'now' },
    ]);
    roleRepo.find.mockResolvedValue([]);
    redis.onlineDevicesByUser.mockResolvedValue(new Map([['guest', ['web-g']]]));

    const marked = await service.listWorkspaceMembers('ws1', 'boss', true);

    // Presence keys are compared lower-cased, whatever the row's own spelling.
    expect(marked.map((m) => [m.userId, 'online' in m && m.online])).toEqual([
      ['boss', false],
      ['Guest', true],
    ]);
  });

  it('listChannelMembers refuses a private channel roster to a member without access', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'outsider',
      roleIds: ['r-member'],
    });
    roleRepo.find.mockResolvedValue([
      { id: 'r-member', name: 'Membre', priority: 1, permissions: [] },
    ]);

    await expect(service.listChannelMembers('ch1', 'outsider')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  // ── A channel-scoped action must not mutate workspace-scoped state ──────────
  //
  // Membership is stored PER WORKSPACE: a public channel is readable by every member of the
  // community and has no per-user access row at all, while a private one restricts an existing
  // member through `allowedUsers`. So the only thing a channel-scoped operation may touch is the
  // channel. `leaveChannel` deleted the community membership row instead, which is how a user who
  // left one channel ended up outside the community while their client still displayed it: the
  // list is local until the next refetch, and every workspace-scoped call then answers 404 -
  // "leave the community" included, which is what made it unmanageable rather than simply gone.

  /**
   * A member table that BEHAVES like one: `delete` removes rows and `findOne` stops finding them.
   *
   * These cases pin a write made by ONE operation and observed by ANOTHER, which a per-call mock
   * cannot express - it answers every question independently of what the previous call did, so the
   * defect disappears into the arrangement.
   */
  function seedMemberTable(
    memberRepo: { findOne: jest.Mock; find: jest.Mock; delete: jest.Mock; update: jest.Mock },
    seeded: Array<{ workspaceId: string; userId: string; roleIds: string[] }>
  ) {
    // Each row carries an id, as a real one does: a member write is keyed by the row it read.
    const rows: Array<{ id: string; workspaceId: string; userId: string; roleIds: string[] }> =
      seeded.map((r) => ({ id: `m-${r.workspaceId}-${r.userId}`, ...r }));
    const matches = (row: (typeof rows)[number], where: Partial<(typeof rows)[number]>) =>
      (where.id === undefined || row.id === where.id) &&
      (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
      (where.userId === undefined || row.userId === where.userId);

    // An UPDATE changes the rows it matches and inserts none; `affected` says how many it found.
    memberRepo.update.mockImplementation(
      (where: Partial<(typeof rows)[number]>, patch: Partial<(typeof rows)[number]>) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ affected: hit.length });
      }
    );
    // The role assignment's conditioned UPDATE: by id, and only while the roles are the ones judged.
    Object.assign(memberRepo, {
      createQueryBuilder: () => roleUpdateBuilder(rows),
    });

    memberRepo.findOne.mockImplementation(({ where }: { where: Partial<(typeof rows)[number]> }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null)
    );
    memberRepo.find.mockImplementation(({ where }: { where: Partial<(typeof rows)[number]> }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)))
    );
    memberRepo.delete.mockImplementation((where: Partial<(typeof rows)[number]>) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return Promise.resolve({ affected: 1 });
    });
    return rows;
  }

  /** A community with one channel, one plain member, and just enough repo answers to act on it. */
  function arrangeCommunityWithOneChannel(
    repos: ReturnType<typeof makeService>,
    { isPrivate }: { isPrivate: boolean }
  ) {
    const rows = seedMemberTable(repos.memberRepo, [
      { workspaceId: 'ws1', userId: 'u1', roleIds: [] },
      { workspaceId: 'ws1', userId: 'boss', roleIds: ['r-admin'] },
    ]);
    const channel = {
      id: 'ch1',
      workspaceId: 'ws1',
      name: 'general',
      isPrivate,
      allowedUsers: isPrivate ? ['u1', 'boss'] : [],
      keyVersion: 1,
      masterSecret: null as string | null,
    };
    repos.channelRepo.findOne.mockResolvedValue(channel);
    repos.channelRepo.save.mockImplementation((c: unknown) => Promise.resolve(c));
    repos.workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', slug: 'ws1' });
    repos.workspaceRepo.find.mockResolvedValue([{ id: 'ws1', slug: 'ws1' }]);
    repos.roleRepo.find.mockResolvedValue([
      { id: 'r-admin', name: 'Administrateur', priority: 10, permissions: ['workspace.manage'] },
    ]);
    return { rows, channel };
  }

  it('a member who left a public channel can still leave the community', async () => {
    const repos = makeService();
    arrangeCommunityWithOneChannel(repos, { isPrivate: false });

    await repos.service.leaveChannel('ch1', { userId: 'u1' }).catch(() => undefined);

    // The user-visible half of the report: the community is still on screen and the button that
    // would get rid of it answers "Not a member of this workspace".
    await expect(repos.service.leaveWorkspace('ws1', 'u1')).resolves.toEqual({ success: true });
  });

  it('leaving a public channel leaves the community roster untouched', async () => {
    const repos = makeService();
    const { rows } = arrangeCommunityWithOneChannel(repos, { isPrivate: false });

    await repos.service.leaveChannel('ch1', { userId: 'u1' }).catch(() => undefined);

    // A public channel has no per-member access to remove, so there is nothing here to delete.
    expect(rows.map((r) => r.userId).sort()).toEqual(['boss', 'u1']);
  });

  it('refuses to leave a public channel rather than pretending it removed something', async () => {
    const repos = makeService();
    arrangeCommunityWithOneChannel(repos, { isPrivate: false });

    // Answering `{ success: true }` would be a lie the next refetch exposes: the channel comes
    // straight back. The refusal is what sends the caller to the operation that does exist.
    await expect(repos.service.leaveChannel('ch1', { userId: 'u1' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('leaving a private channel drops the access and keeps the community membership', async () => {
    const repos = makeService();
    const { rows, channel } = arrangeCommunityWithOneChannel(repos, { isPrivate: true });

    await expect(repos.service.leaveChannel('ch1', { userId: 'u1' })).resolves.toEqual({
      success: true,
    });

    expect(channel.allowedUsers).toEqual(['boss']);
    expect(rows.map((r) => r.userId).sort()).toEqual(['boss', 'u1']);
  });

  it('leaving a private channel announces a removal whose actor is the leaver', async () => {
    const repos = makeService();
    arrangeCommunityWithOneChannel(repos, { isPrivate: true });

    await repos.service.leaveChannel('ch1', { userId: 'u1' });

    // The remaining members elect the device that commits the key-group Remove from this event,
    // and the leaver's other devices drop the salon from it - so the leaver must be in the list
    // even though `allowedUsers` no longer names them.
    expect(repos.redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.member.removed',
      expect.objectContaining({
        channelId: 'ch1',
        workspaceId: 'ws1',
        removedUserId: 'u1',
        removedBy: 'u1',
        isPrivate: true,
        // The revision the strip left, so a client that saw a later grant does not purge.
        accessRevision: expect.any(Number),
      }),
      expect.arrayContaining(['u1'])
    );
    // A leave names no committing device: the leaver's own leaf is the one leaving.
    const calls = repos.redis.publishChannelEvent.mock.calls as unknown[][];
    expect(calls[calls.length - 1][1]).not.toHaveProperty('actorDeviceId');
  });

  it('a leave whose announcement fails is still a leave, not a 500', async () => {
    const repos = makeService();
    const { channel } = arrangeCommunityWithOneChannel(repos, { isPrivate: true });
    repos.redis.publishChannelEvent.mockRejectedValueOnce(new Error('redis down'));

    await expect(repos.service.leaveChannel('ch1', { userId: 'u1' })).resolves.toEqual({
      success: true,
    });
    expect(channel.allowedUsers).toEqual(['boss']);
  });

  // ── The governance postcondition (2026-08-18) ──────────────────────────────────────────────
  //
  // Every operation below used to check what the ACTOR may do and never what the community would
  // be LEFT AS. Measured on prod 2026-08-17: 15 of 29 communities had exactly one admin, 5 had no
  // members at all, and all 10 live invites were unbounded. These cases pin the postcondition from
  // each of the six sides it can be reached from, because guarding one alone leaves the hole open.

  const GOVERNED_ROLES = [
    { id: 'r-admin', name: 'Administrateur', priority: 100, permissions: ['workspace.manage'] },
    {
      id: 'r-mod',
      name: 'Modérateur',
      priority: 50,
      permissions: ['member.kick', 'role.manage', 'member.invite'],
    },
    { id: 'r-member', name: 'Membre', priority: 10, permissions: ['member.invite'] },
  ];

  /** A community whose roster is a real table, so a write by one call is seen by the next. */
  function arrangeGovernedCommunity(
    repos: ReturnType<typeof makeService>,
    members: Array<{ userId: string; roleIds: string[] }>
  ) {
    const rows = seedMemberTable(
      repos.memberRepo,
      members.map((mem) => ({ workspaceId: 'ws1', ...mem }))
    );
    repos.memberRepo.save.mockImplementation((m: unknown) => Promise.resolve(m));
    repos.workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', slug: 'ws1' });
    repos.roleRepo.find.mockResolvedValue(GOVERNED_ROLES);
    // By name for the early read, by id for the re-read under the removal lock.
    repos.roleRepo.findOne.mockImplementation(
      ({ where }: { where: { name?: string; id?: string } }) =>
        Promise.resolve(
          GOVERNED_ROLES.find((r) => (where.id ? r.id === where.id : r.name === where.name)) ?? null
        )
    );
    repos.channelRepo.find.mockResolvedValue([{ id: 'ch1' }]);
    return rows;
  }

  /** The refusal's `code`, which is what every client branches on - never its sentence. */
  async function refusalCode(promise: Promise<unknown>): Promise<unknown> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e
    );
    return err instanceof BadRequestException || err instanceof NotFoundException
      ? err.getResponse()
      : err;
  }

  it('refuses the last admin leaving while other members remain', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'u1', roleIds: ['r-member'] },
    ]);

    expect(await refusalCode(repos.service.leaveWorkspace('ws1', 'boss'))).toMatchObject({
      code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
    });
    expect(rows.map((r) => r.userId).sort()).toEqual(['boss', 'u1']);
  });

  it('lets the last member leave, and deletes the community with them', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);

    await expect(repos.service.leaveWorkspace('ws1', 'boss')).resolves.toEqual({ success: true });

    expect(rows).toHaveLength(0);
    // Six tables, each named: nothing cascades here, so one left out is an orphan nobody sees.
    expect(repos.hardDeletes).toHaveBeenCalledTimes(6);
  });

  it('refuses to kick the last admin, whatever the actor is allowed to do', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'mod', roleIds: ['r-mod'] },
    ]);

    // KICK_MEMBERS alone used to be enough: the target's roles were never consulted at all.
    expect(await refusalCode(repos.service.kickFromWorkspace('ws1', 'boss', 'mod'))).toMatchObject({
      code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
    });
    expect(rows.map((r) => r.userId).sort()).toEqual(['boss', 'mod']);
  });

  it('refuses to demote the last admin, including oneself', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'u1', roleIds: ['r-member'] },
    ]);

    expect(
      await refusalCode(repos.service.updateWorkspaceMemberRole('ws1', 'boss', 'member', 'boss'))
    ).toMatchObject({ code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN' });
    expect(rows.find((r) => r.userId === 'boss')?.roleIds).toEqual(['r-admin']);
  });

  it('allows a demotion while another admin remains', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'boss2', roleIds: ['r-admin'] },
    ]);

    await expect(
      repos.service.updateWorkspaceMemberRole('ws1', 'boss2', 'member', 'boss')
    ).resolves.toEqual({ success: true });
    expect(rows.find((r) => r.userId === 'boss2')?.roleIds).toEqual(['r-member']);
  });

  it('refuses an invite into a community nobody belongs to any more', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, []);
    repos.inviteRepo.findOne.mockResolvedValue({
      id: 'inv1',
      workspaceId: 'ws1',
      token: 't',
      revoked: false,
      expiresAt: null,
      maxUses: null,
      uses: 0,
    });

    // One forwarded link would otherwise repopulate a community with ZERO admins - the single
    // state nothing inside the community can repair from.
    expect(await refusalCode(repos.service.acceptWorkspaceInvite('t', 'newcomer'))).toMatchObject({
      code: 'WORKSPACE_HAS_NO_MEMBERS',
    });
  });

  it('returns the live invite instead of minting a second one', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);
    repos.inviteRepo.find.mockResolvedValue([
      {
        id: 'inv-old',
        token: 'older',
        revoked: false,
        expiresAt: null,
        maxUses: null,
        uses: 1,
        createdAt: new Date(1000),
      },
      {
        id: 'inv-new',
        token: 'newest',
        revoked: false,
        expiresAt: null,
        maxUses: null,
        uses: 0,
        createdAt: new Date(2000),
      },
    ]);

    const invite = await repos.service.createWorkspaceInvite('ws1', 'boss');

    // The newest live token is "the link"; the stragglers from before this rule are revoked, so
    // revoking what you shared finally revokes something.
    expect(invite.token).toBe('newest');
    expect(repos.inviteRepo.save).not.toHaveBeenCalled();
    expect(repos.inviteRepo.update).toHaveBeenCalledTimes(1);
  });

  it('rotating revokes the live token before minting its replacement', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);
    repos.inviteRepo.find.mockResolvedValue([
      {
        id: 'inv-old',
        token: 'older',
        revoked: false,
        expiresAt: null,
        maxUses: null,
        uses: 0,
        createdAt: new Date(1000),
      },
    ]);

    const invite = await repos.service.createWorkspaceInvite('ws1', 'boss', {
      rotate: true,
      maxUses: 5,
    });

    expect(invite.token).not.toBe('older');
    expect(invite.maxUses).toBe(5);
    expect(repos.inviteRepo.update).toHaveBeenCalledTimes(1);
  });

  it('refuses bounds that would mint a link nobody can use', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);

    expect(
      await refusalCode(
        repos.service.createWorkspaceInvite('ws1', 'boss', { expiresAt: '2000-01-01T00:00:00Z' })
      )
    ).toMatchObject({ code: 'INVITE_EXPIRY_IN_THE_PAST' });
    expect(
      await refusalCode(repos.service.createWorkspaceInvite('ws1', 'boss', { maxUses: 0 }))
    ).toMatchObject({ code: 'INVITE_MAX_USES_INVALID' });
  });

  // ── The admission voucher (channel-encryption section 25) ──────────────────
  //
  // A member hands a community's past only to a newcomer whose admission it can verify. The proof is
  // signed by a member's device and the server cannot forge it; it STORES it on the membership row
  // and serves it with the roster, which is all this side does.

  /** A live link to ws1, with one admin in the community. */
  function arrangeLiveInvite(repos: ReturnType<typeof makeService>) {
    const rows = arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);
    repos.inviteRepo.findOne.mockResolvedValue({
      id: 'inv1',
      workspaceId: 'ws1',
      token: 't',
      revoked: false,
      expiresAt: null,
      maxUses: null,
      uses: 0,
    });
    repos.memberRepo.save.mockImplementation((m: { userId: string }) => {
      rows.push(m as never);
      return Promise.resolve(m);
    });
    // The claim is ONE conditional UPDATE that wins here; the membership is written in its
    // transaction, through the same member repository.
    Object.assign(repos.inviteRepo, {
      manager: {
        transaction: (cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            query: () => Promise.resolve([[{ id: 'inv1' }], 1]),
            getRepository: () => repos.memberRepo,
          }),
      },
    });
    return rows;
  }

  it('a link accepted with a voucher stores it on the new membership row', async () => {
    const repos = makeService();
    const rows = arrangeLiveInvite(repos);

    await repos.service.acceptWorkspaceInvite('t', 'newcomer', 'AAEC-_x');

    expect(rows.find((r) => r.userId === 'newcomer')).toMatchObject({
      admissionVoucher: 'AAEC-_x',
    });
  });

  it('a link accepted with no voucher still admits - it just carries no proof', async () => {
    const repos = makeService();
    const rows = arrangeLiveInvite(repos);

    await expect(repos.service.acceptWorkspaceInvite('t', 'newcomer')).resolves.toMatchObject({
      alreadyMember: false,
    });
    expect(rows.find((r) => r.userId === 'newcomer')).toMatchObject({ admissionVoucher: null });
  });

  it('a member following a new link stores its voucher on the row it already has', async () => {
    // The re-issue path: joined through an old link, so no proof, then sent a fresh one.
    const repos = makeService();
    arrangeLiveInvite(repos);
    repos.memberRepo.findOne.mockResolvedValue({
      id: 'm-boss',
      workspaceId: 'ws1',
      userId: 'boss',
    });

    await expect(repos.service.acceptWorkspaceInvite('t', 'boss', 'Zm9v')).resolves.toMatchObject({
      alreadyMember: true,
    });
    expect(repos.memberRepo.update).toHaveBeenCalledWith(
      { id: 'm-boss' },
      { admissionVoucher: 'Zm9v' }
    );
  });

  it('refuses a voucher that is not a bounded base64url string', async () => {
    const repos = makeService();
    arrangeLiveInvite(repos);

    for (const bad of ['has space', 'x'.repeat(4097), 42 as unknown as string]) {
      expect(
        await refusalCode(repos.service.acceptWorkspaceInvite('t', 'newcomer', bad))
      ).toMatchObject({ code: 'ADMISSION_VOUCHER_INVALID' });
    }
    expect(repos.memberRepo.save).not.toHaveBeenCalled();
  });

  it('serves each member voucher and the creator mark with the roster', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1', createdBy: 'boss' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'boss', roleIds: [] });
    memberRepo.find.mockResolvedValue([
      { id: 'm1', userId: 'boss', roleIds: [], createdAt: 'then', admissionVoucher: null },
      { id: 'm2', userId: 'guest', roleIds: [], createdAt: 'now', admissionVoucher: 'dm91Y2g' },
    ]);
    roleRepo.find.mockResolvedValue([]);

    const roster = await service.listWorkspaceMembers('ws1', 'boss');

    expect(roster.map((m) => [m.userId, m.isCreator, m.admissionVoucher])).toEqual([
      ['boss', true, null],
      ['guest', false, 'dm91Y2g'],
    ]);
  });

  it('account deletion promotes a successor rather than leaving a community ungoverned', async () => {
    const repos = makeService();
    // The departing admin's row still exists: the repair runs BEFORE it is deleted, treating it as
    // gone, so a failure leaves the row for the erasure retry to find.
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'zoe', roleIds: ['r-member'] },
      { userId: 'mod', roleIds: ['r-mod'] },
      { userId: 'amy', roleIds: ['r-member'] },
    ]);

    expect(await repos.service.removeAccountFromWorkspaces('boss')).toBe(1);

    // Highest-priority survivor, deterministically - no clock and no tie left to chance.
    expect(rows.find((r) => r.userId === 'mod')?.roleIds).toEqual(['r-admin']);
    expect(rows.map((r) => r.userId)).not.toContain('boss');
    expect(repos.hardDeletes).not.toHaveBeenCalled();
  });

  it('account deletion promotes by rank before what the roles grant', async () => {
    // A Moderateur outranks a custom role even where the custom role grants more: counting
    // permissions alone would promote 'aaa'.
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'aaa', roleIds: ['r-custom-big'] },
      { userId: 'mod', roleIds: ['r-mod'] },
    ]);
    repos.roleRepo.find.mockResolvedValue([
      ...GOVERNED_ROLES,
      {
        id: 'r-custom-big',
        name: 'Gardien',
        priority: 11,
        permissions: ['channel.manage', 'channel.moderate', 'member.invite', 'member.kick'],
      },
    ]);

    await repos.service.removeAccountFromWorkspaces('boss');

    expect(rows.find((r) => r.userId === 'mod')?.roleIds).toEqual(['r-admin']);
    expect(rows.find((r) => r.userId === 'aaa')?.roleIds).toEqual(['r-custom-big']);
  });

  it('account deletion breaks a tie in rank by what the roles grant, before the user id', async () => {
    // Custom roles share one rank (`createRole` places each just above the base role), so among
    // them the successor is the one whose roles grant the most: rank and user id alone would
    // promote 'aaa'.
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'aaa', roleIds: ['r-custom-1'] },
      { userId: 'bbb', roleIds: ['r-custom-2'] },
    ]);
    repos.roleRepo.find.mockResolvedValue([
      ...GOVERNED_ROLES,
      { id: 'r-custom-1', name: 'Aide', priority: 11, permissions: ['member.invite'] },
      {
        id: 'r-custom-2',
        name: 'Gardien',
        priority: 11,
        permissions: ['member.invite', 'member.kick'],
      },
    ]);

    await repos.service.removeAccountFromWorkspaces('boss');

    expect(rows.find((r) => r.userId === 'bbb')?.roleIds).toEqual(['r-admin']);
    expect(rows.find((r) => r.userId === 'aaa')?.roleIds).toEqual(['r-custom-1']);
  });

  it('account deletion deletes a community it emptied', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, [{ userId: 'boss', roleIds: ['r-admin'] }]);

    await repos.service.removeAccountFromWorkspaces('boss');

    expect(repos.hardDeletes).toHaveBeenCalledTimes(6);
  });

  it('a failed repair KEEPS the membership row and throws, so the retry repairs that community', async () => {
    const repos = makeService();
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'boss', roleIds: ['r-admin'] },
      { userId: 'mod', roleIds: ['r-mod'] },
    ]);
    const update = repos.memberRepo.update.getMockImplementation();
    repos.memberRepo.update.mockImplementationOnce(() => Promise.reject(new Error('db blip')));

    // The old version deleted the row first and swallowed this: the community stayed without an
    // admin and the retry, finding no membership, never looked at it again.
    await expect(repos.service.removeAccountFromWorkspaces('boss')).rejects.toThrow(
      /account removal incomplete: 1\/1/
    );
    expect(rows.map((r) => r.userId)).toContain('boss');

    repos.memberRepo.update.mockImplementation(update!);
    await repos.service.removeAccountFromWorkspaces('boss');
    expect(rows.find((r) => r.userId === 'mod')?.roleIds).toEqual(['r-admin']);
    expect(rows.map((r) => r.userId)).not.toContain('boss');
  });

  it('a transient failure (chat-delivery down, a database blip) answers 503, a refusal answers 409', async () => {
    const mk = () => {
      const repos = makeService();
      arrangeGovernedCommunity(repos, [
        { userId: 'boss', roleIds: ['r-admin'] },
        { userId: 'mod', roleIds: ['r-mod'] },
      ]);
      return repos;
    };
    const blip = mk();
    blip.memberRepo.update.mockImplementationOnce(() => Promise.reject(new Error('db blip')));
    await expect(blip.service.removeAccountFromWorkspaces('boss')).rejects.toMatchObject({
      status: 503,
    });

    const refused = mk();
    refused.memberRepo.update.mockImplementationOnce(() =>
      Promise.reject(new ForbiddenException('refused'))
    );
    await expect(refused.service.removeAccountFromWorkspaces('boss')).rejects.toMatchObject({
      status: 409,
    });

    // A programming error is deterministic: permanent, never a quiet 503.
    const defect = mk();
    defect.memberRepo.update.mockImplementationOnce(() =>
      Promise.reject(new TypeError('x is undefined'))
    );
    await expect(defect.service.removeAccountFromWorkspaces('boss')).rejects.toMatchObject({
      status: 409,
    });
  });

  describe('the Graine history floor (WP-34)', () => {
    /**
     * WHERE A MEMBER'S PAST STOPS, computed on the server because only the server holds both halves.
     *
     * A Graine session can span an arrival - rotation is decided by the SENDER when it notices the
     * distribution group's epoch has moved, and a join is an external commit it learns of late - so
     * "withhold the session" and "hand the session over" are both wrong for the same session. The
     * floor is the third answer, and it is drawn between the member's own arrival row and the message
     * dates, which are two columns written by ONE clock.
     */
    function readableChannel(
      channelRepo: { findOne: jest.Mock },
      memberRepo: { findOne: jest.Mock }
    ) {
      channelRepo.findOne.mockResolvedValue({
        id: 'chan-1',
        workspaceId: 'ws-1',
        isPrivate: false,
        allowedUsers: [],
      });
      memberRepo.findOne.mockResolvedValue({
        workspaceId: 'ws-1',
        userId: 'newcomer',
        createdAt: new Date('2026-08-20T12:00:00Z'),
      });
    }

    it('answers a floor for a session that spans the arrival, and omits one entirely before it', async () => {
      const { service, channelRepo, memberRepo, floorRows } = makeService();
      readableChannel(channelRepo, memberRepo);
      floorRows.push({ sessionId: 'spanning', floor: '7' });

      const floors = await service.getGraineHistoryFloors('chan-1', 'answerer', 'newcomer', [
        'spanning',
        'entirely-before',
      ]);

      // ABSENCE, NOT A ZERO. "Give it from index 7" and "there is nothing here you may read" are
      // different instructions, and a zero would read as the second meaning the first.
      expect(floors).toEqual({ spanning: 7 });
    });

    it('refuses when the person the seed is for is not a member', async () => {
      const { service, channelRepo, memberRepo } = makeService();
      channelRepo.findOne.mockResolvedValue({
        id: 'chan-1',
        workspaceId: 'ws-1',
        isPrivate: false,
        allowedUsers: [],
      });
      // The caller reads the channel; the person the floor is for has no arrival at all.
      memberRepo.findOne
        .mockResolvedValueOnce({ workspaceId: 'ws-1', userId: 'answerer' })
        .mockResolvedValueOnce(null);

      // A refusal rather than an empty object: the caller must fail closed, and an empty object is
      // also what a member with nothing readable looks like.
      await expect(
        service.getGraineHistoryFloors('chan-1', 'answerer', 'stranger', ['s-1'])
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a caller who cannot read the channel', async () => {
      const { service, channelRepo, memberRepo } = makeService();
      channelRepo.findOne.mockResolvedValue({
        id: 'chan-1',
        workspaceId: 'ws-1',
        isPrivate: true,
        allowedUsers: ['someone-else'],
      });
      memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws-1', userId: 'outsider' });

      // The floor names which messages exist and when, for a salon this caller may not open.
      await expect(
        service.getGraineHistoryFloors('chan-1', 'outsider', 'newcomer', ['s-1'])
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
