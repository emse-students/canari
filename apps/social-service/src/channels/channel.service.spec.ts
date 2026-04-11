import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ChannelService } from './channel.service';

describe('ChannelService security hardening', () => {
  function makeService() {
    const workspaceRepo: any = {};
    const channelRepo: any = { findOne: jest.fn(), save: jest.fn() };
    const roleRepo: any = { find: jest.fn() };
    const memberRepo: any = { findOne: jest.fn(), find: jest.fn() };
    const messageRepo: any = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    const keyDistributionRepo: any = {
      findOne: jest.fn(),
      save: jest.fn(async (x) => x),
      create: jest.fn((x) => x),
    };
    const redis: any = { publishChannelEvent: jest.fn(async () => {}) };

    const service = new ChannelService(
      workspaceRepo,
      channelRepo,
      roleRepo,
      memberRepo,
      messageRepo,
      keyDistributionRepo,
      redis
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

    const distribution = {
      id: 'd1',
      channelId: 'ch1',
      workspaceId: 'ws1',
      targetUserId: 'u2',
      invitedBy: 'u1',
      keyVersion: 3,
      status: 'key_sent',
      attempts: 0,
    } as any;

    keyDistributionRepo.findOne.mockImplementation(async () => distribution);

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
