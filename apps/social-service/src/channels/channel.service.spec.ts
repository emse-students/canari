import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { ChannelKeyDistribution } from './entities/channel-key-distribution.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

describe('ChannelService security hardening', () => {
  function makeService() {
    const workspaceRepo = {} as Repository<Workspace>;
    const channelRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };
    const roleRepo = {
      find: jest.fn(),
    };
    const memberRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    };
    const messageRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(),
      },
    };
    const keyDistributionRepo = {
      findOne: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const inviteRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      increment: jest.fn(() => Promise.resolve()),
    };
    const redis = {
      publishChannelEvent: jest.fn(() => Promise.resolve()),
    };

    const service = new ChannelService(
      workspaceRepo,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      keyDistributionRepo as unknown as Repository<ChannelKeyDistribution>,
      inviteRepo as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );

    return {
      service,
      channelRepo,
      roleRepo,
      memberRepo,
      messageRepo,
      keyDistributionRepo,
      redis,
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
      allowedRoles: [],
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
    roleRepo.find.mockResolvedValue([{ permissions: ['MODERATE_MESSAGES'] }]);
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

  it('rejects listMessages for private channel without allowed role', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: true,
      allowedRoles: ['r-admin'],
      keyVersion: 1,
      masterSecret: Buffer.alloc(32).toString('base64'),
    });
    memberRepo.findOne.mockResolvedValue({
      workspaceId: 'ws1',
      userId: 'u1',
      roleIds: ['r-member'],
    });

    await expect(service.listMessages('ch1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns sanitized channels with key bootstrap for accessible members', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });
    channelRepo.find.mockResolvedValue([
      {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        isPrivate: false,
        allowedRoles: [],
        keyVersion: 2,
        masterSecret: Buffer.alloc(32).toString('base64'),
        imageMediaId: null,
      },
    ]);

    await expect(service.listChannelsForUser('ws1', 'u1')).resolves.toEqual([
      expect.objectContaining({
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        visibility: 'public',
        keyVersion: 2,
        keyBootstrap: expect.objectContaining({
          channelId: 'ch1',
          keyVersion: 2,
        }),
      }),
    ]);
  });

  it('rejects sendMessage when keyVersion is missing', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      allowedRoles: [],
      keyVersion: 5,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

    await expect(
      service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects sendMessage when keyVersion is stale', async () => {
    const { service, channelRepo, memberRepo } = makeService();
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      allowedRoles: [],
      keyVersion: 7,
    });
    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u1', roleIds: [] });

    await expect(
      service.sendMessage('ch1', {
        senderId: 'u1',
        ciphertext: 'abc',
        nonce: 'def',
        keyVersion: 6,
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects invalid distribution transition pending -> key_received', async () => {
    const { service, keyDistributionRepo, memberRepo, channelRepo } = makeService();

    keyDistributionRepo.findOne.mockResolvedValue({
      id: 'd1',
      channelId: 'ch1',
      workspaceId: 'ws1',
      targetUserId: 'u2',
      invitedBy: 'u1',
      keyVersion: 3,
      status: 'pending_key_distribution',
    });

    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u2', roleIds: [] });
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      allowedRoles: [],
    });

    await expect(service.markKeyDistributionReceived('ch1', 'd1', 'u2', 3)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('accepts valid distribution chain sent -> received -> acked', async () => {
    const { service, keyDistributionRepo, memberRepo, channelRepo } = makeService();

    const distribution: ChannelKeyDistribution = {
      id: 'd1',
      channelId: 'ch1',
      workspaceId: 'ws1',
      targetUserId: 'u2',
      invitedBy: 'u1',
      keyVersion: 3,
      status: 'key_sent',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receivedAt: null,
      ackedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    keyDistributionRepo.findOne.mockImplementation(() => Promise.resolve(distribution));

    memberRepo.findOne.mockResolvedValue({ workspaceId: 'ws1', userId: 'u2', roleIds: [] });
    channelRepo.findOne.mockResolvedValue({
      id: 'ch1',
      workspaceId: 'ws1',
      isPrivate: false,
      allowedRoles: [],
    });

    await expect(service.markKeyDistributionReceived('ch1', 'd1', 'u2', 3)).resolves.toEqual(
      expect.objectContaining({ success: true, status: 'key_received' })
    );
    expect(distribution.status).toBe('key_received');

    await expect(service.ackKeyDistribution('ch1', 'd1', 'u2', 3)).resolves.toEqual(
      expect.objectContaining({ success: true, status: 'key_acked' })
    );
    expect(distribution.status).toBe('key_acked');
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
      const { service, memberRepo } = makeService();
      const channel = {
        id: 'ch1',
        workspaceId: 'ws1',
        name: 'general',
        isPrivate: false,
        allowedRoles: [] as string[],
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
        { id: 'm1', keyVersion: 1, createdAt: new Date() },
        { senderId: 'u1', ciphertext: 'c', nonce: 'n', mentionedUserIds: ['u5'] }
      );

      const notifiedUsers = fetchMock.mock.calls
        .map((call) => JSON.parse(call[1].body).userId as string)
        .sort();
      expect(notifiedUsers).toEqual(['u2', 'u5']);
    } finally {
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
        allowedRoles: [] as string[],
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
      allowedRoles: [],
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
});
