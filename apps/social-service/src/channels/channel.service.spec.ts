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
