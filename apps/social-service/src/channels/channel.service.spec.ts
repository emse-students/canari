import { ForbiddenException, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

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
      manager: {
        transaction: jest.fn((cb: (m: { delete: typeof hardDeletes }) => Promise<void>) =>
          cb({ delete: hardDeletes })
        ),
      },
    };
    const channelRepo = {
      findOne: jest.fn(),
      // Empty by default rather than undefined: `find` is now on the departure path (every private
      // salon a leaver must be cut from), and a bare `jest.fn()` there fails as a TypeError deep
      // inside the service instead of as the assertion the test is about.
      find: jest.fn().mockResolvedValue([]),
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
      save: jest.fn(),
      delete: jest.fn(),
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
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(),
      },
    };
    const inviteRepo = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      increment: jest.fn(() => Promise.resolve()),
    };
    const redis = {
      publishChannelEvent: jest.fn(() => Promise.resolve()),
    };

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
    expect(workspaceRepo.save).not.toHaveBeenCalled();
  });

  it('updateWorkspaceHistoryVisibility refuses a member without MANAGE_WORKSPACE', async () => {
    const { service, workspaceRepo, memberRepo, roleRepo } = makeService();
    workspaceRepo.findOne.mockResolvedValue({ id: 'ws1' });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: ['r1'] });
    roleRepo.find.mockResolvedValue([{ id: 'r1', permissions: ['member.invite'] }]);

    await expect(
      service.updateWorkspaceHistoryVisibility('ws1', 'u1', 'joined')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaceRepo.save).not.toHaveBeenCalled();
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
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }]);

    await service.kickFromWorkspace('ws1', 'u-bob', 'u1');

    // The exact payload matters: an absent channelId is what marks the removal as
    // community-wide on the client, and the target must be in the notify list.
    expect(redis.publishChannelEvent).toHaveBeenCalledWith(
      'channel.member.kicked',
      { workspaceId: 'ws1', kickedUserId: 'u-bob', kickedBy: 'u1' },
      expect.arrayContaining(['u-bob'])
    );
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
    memberRepo.find.mockResolvedValue([{ userId: 'u1' }]);

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

    await service.deleteChannelMessage('ch1', 'm1', 'u1');

    expect(messageRepo.delete).toHaveBeenCalledWith({ id: 'm1', channelId: 'ch1' });
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

    await service.deleteChannelMessage('ch1', 'm1', 'u1');

    expect(messageRepo.delete).toHaveBeenCalledWith({ id: 'm1', channelId: 'ch1' });
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
      silent: true,
    });

    // A heart that rang every phone in the community is a community people mute.
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
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
    });

    // A falsy-index guard would refuse the first message of every session, which is the one
    // message every reader is guaranteed to want.
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ senderSessionId: 'sess-1', messageIndex: 0 })
    );
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

  it('setNotificationLevel persists the level and rejects non-members', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({ id: 'ch1', workspaceId: 'ws1', isPrivate: false });

    const member = { workspaceId: 'ws1', userId: 'u1', notifLevels: {} as Record<string, string> };
    memberRepo.findOne.mockResolvedValueOnce(member);
    await expect(service.setNotificationLevel('ch1', 'u1', 'none')).resolves.toEqual({
      channelId: 'ch1',
      level: 'none',
    });
    expect(member.notifLevels).toEqual({ ch1: 'none' });
    expect(memberRepo.save).toHaveBeenCalledWith(member);

    memberRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.setNotificationLevel('ch1', 'uX', 'all')).rejects.toBeInstanceOf(
      ForbiddenException
    );
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
        { id: 'm1', senderSessionId: 'sess-1', messageIndex: 4, createdAt: new Date() },
        {
          senderId: 'u1',
          ciphertext: 'c',
          nonce: 'n',
          senderSessionId: 'sess-1',
          messageIndex: 4,
          mentionedUserIds: ['u5'],
        }
      );

      const sent = fetchMock.mock.calls
        .map(
          (call) =>
            JSON.parse(call[1].body) as {
              userId: string;
              title: string;
              data: Record<string, string>;
            }
        )
        .sort((a, b) => a.userId.localeCompare(b.userId));
      expect(sent.map((s) => s.userId)).toEqual(['u2', 'u5']);

      // The mention travels per recipient: only u5 was named, and the device routes its own
      // notification channel on this field alone (it cannot read the ciphertext to find out).
      expect(sent[0].data.mentioned).toBe('false');
      expect(sent[1].data.mentioned).toBe('true');

      // And the payload carries nothing a client does not read: workspaceId / messageId / createdAt
      // were dropped once measured dead on all three clients. A field nobody reads still costs
      // room under FCM's 4 KB cap, which the inlined ciphertext competes for.
      expect(Object.keys(sent[0].data).sort()).toEqual([
        'channelId',
        'channelName',
        'ciphertext',
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
      expect(sent[0].data.messageIndex).toBe('4');

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
    const member: {
      workspaceId: string;
      userId: string;
      roleIds: string[];
      notifLevels?: Record<string, string>;
    } = {
      workspaceId: 'ws1',
      userId: 'u1',
      roleIds: [],
    };
    memberRepo.findOne.mockResolvedValue(member);

    await service.setNotificationLevel('__proto__', 'u1', 'none');

    // The stored key is the canonical channel.id, never the raw '__proto__' param.
    expect(member.notifLevels).toEqual({ ch1: 'none' });
    expect(Object.prototype.hasOwnProperty.call(member.notifLevels, '__proto__')).toBe(false);
    expect(memberRepo.save).toHaveBeenCalledWith(member);
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
    expect(members.map((m) => m.userId).sort()).toEqual(['boss', 'guest']);
  });

  it('listChannelMembers with scope=workspace still returns the whole community roster', async () => {
    const { service, channelRepo, memberRepo, roleRepo } = makeService();
    arrangePrivateChannelRoster({ channelRepo, memberRepo, roleRepo });

    // The settings picker grants access to people who are not in the channel yet.
    const members = await service.listChannelMembers('ch1', 'boss', 'workspace');

    expect(members.map((m) => m.userId).sort()).toEqual(['boss', 'guest', 'outsider']);
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
    memberRepo: { findOne: jest.Mock; find: jest.Mock; delete: jest.Mock },
    rows: Array<{ workspaceId: string; userId: string; roleIds: string[] }>
  ) {
    const matches = (row: (typeof rows)[number], where: Partial<(typeof rows)[number]>) =>
      (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
      (where.userId === undefined || row.userId === where.userId);

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
    repos.roleRepo.findOne.mockImplementation(({ where }: { where: { name: string } }) =>
      Promise.resolve(GOVERNED_ROLES.find((r) => r.name === where.name) ?? null)
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

  it('account deletion promotes a successor rather than leaving a community ungoverned', async () => {
    const repos = makeService();
    // The admin's membership row is already gone: this route deletes it directly, which is the one
    // path that cannot refuse, and therefore the one place a repair exists.
    const rows = arrangeGovernedCommunity(repos, [
      { userId: 'zoe', roleIds: ['r-member'] },
      { userId: 'mod', roleIds: ['r-mod'] },
      { userId: 'amy', roleIds: ['r-member'] },
    ]);

    await repos.service.repairWorkspacesAfterAccountDeletion(['ws1'], 'boss');

    // Highest-priority survivor, deterministically - no clock and no tie left to chance.
    expect(rows.find((r) => r.userId === 'mod')?.roleIds).toEqual(['r-admin']);
    expect(repos.hardDeletes).not.toHaveBeenCalled();
  });

  it('account deletion deletes a community it emptied', async () => {
    const repos = makeService();
    arrangeGovernedCommunity(repos, []);

    await repos.service.repairWorkspacesAfterAccountDeletion(['ws1'], 'boss');

    expect(repos.hardDeletes).toHaveBeenCalledTimes(6);
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
