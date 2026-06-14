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
});
