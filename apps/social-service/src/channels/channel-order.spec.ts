import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  ChannelService,
  DEFAULT_CHANNEL_NAME,
  sortChannels,
  validateChannelName,
} from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * THE ORDER OF A COMMUNITY'S SALONS, AND A NAME THAT IS ONLY A NAME.
 *
 * The order is shared and written by whoever may manage salons; the name is a display string stored
 * exactly as typed, with the channel id as its only identity.
 */
describe('channel order and free-format names', () => {
  const MANAGER = 'manager';
  const MEMBER = 'member';
  const FREE_NAME = 'Général 🎉 Équipe';

  const t = (n: number) => new Date(2026, 0, 1, 0, 0, n);
  const channels = [
    {
      id: 'a',
      workspaceId: 'ws1',
      name: 'a',
      isPrivate: false,
      allowedUsers: [],
      sortOrder: 0,
      createdAt: t(1),
    },
    {
      id: 'b',
      workspaceId: 'ws1',
      name: 'b',
      isPrivate: false,
      allowedUsers: [],
      sortOrder: 1,
      createdAt: t(2),
    },
    {
      id: 'c',
      workspaceId: 'ws1',
      name: 'c',
      isPrivate: false,
      allowedUsers: [],
      sortOrder: 2,
      createdAt: t(3),
    },
    // Private and NOT readable by the manager: it must keep its slot whatever the manager drags.
    {
      id: 'p',
      workspaceId: 'ws1',
      name: 'p',
      isPrivate: true,
      allowedUsers: ['someone'],
      sortOrder: 3,
      createdAt: t(4),
    },
  ];
  const roles = [
    { id: 'r-chan', workspaceId: 'ws1', permissions: ['channel.manage'], priority: 5 },
    { id: 'r-member', workspaceId: 'ws1', permissions: ['member.invite'], priority: 1 },
  ];
  const roster = [
    { userId: MANAGER, roleIds: ['r-chan'] },
    { userId: MEMBER, roleIds: ['r-member'] },
  ];

  function makeService() {
    const updates: Array<{ id: string; sortOrder: number }> = [];
    const saved: Array<Record<string, unknown>> = [];
    const channelRepo = {
      find: jest.fn(() => Promise.resolve(channels)),
      findOne: jest.fn((q: { where: { id: string } }) =>
        Promise.resolve(channels.find((c) => c.id === q.where.id) ?? null)
      ),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: 'new', workspaceId: 'ws1' });
      }),
      maximum: jest.fn(() => Promise.resolve(3)),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => Promise<void>) =>
          fn({
            update: (_e: unknown, where: { id: string }, set: { sortOrder: number }) => {
              updates.push({ id: where.id, sortOrder: set.sortOrder });
              return Promise.resolve();
            },
          })
        ),
      },
    };
    const roleRepo = {
      find: jest.fn((q?: { where?: { id?: { _value?: string[] } } }) => {
        const wanted = q?.where?.id?._value;
        return Promise.resolve(wanted ? roles.filter((r) => wanted.includes(r.id)) : roles);
      }),
    };
    const memberRepo = {
      find: jest.fn(() => Promise.resolve(roster)),
      findOne: jest.fn((q: { where: { userId: string } }) =>
        Promise.resolve(roster.find((m) => m.userId === q.where.userId) ?? null)
      ),
    };
    const redis = { publishChannelEvent: jest.fn(() => Promise.resolve()) };
    const service = new ChannelService(
      {
        findOne: jest.fn(() => Promise.resolve({ id: 'ws1', slug: 'ws' })),
      } as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      {} as unknown as Repository<ChannelMessage>,
      { findOne: jest.fn() } as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    return { service, updates, saved, redis, channelRepo };
  }

  describe('reorderChannels', () => {
    it('writes the new order, keeps the hidden private salon in its slot, and tells the community', async () => {
      const { service, updates, redis } = makeService();
      await service.reorderChannels('ws1', MANAGER, ['c', 'a', 'b']);
      expect(updates).toEqual([
        { id: 'c', sortOrder: 0 },
        { id: 'a', sortOrder: 1 },
        { id: 'b', sortOrder: 2 },
        { id: 'p', sortOrder: 3 },
      ]);
      expect(redis.publishChannelEvent).toHaveBeenCalledWith(
        'workspace.updated',
        { workspaceId: 'ws1', channelsReordered: true },
        expect.any(Array)
      );
    });

    it('refuses a member who may not manage salons, and writes nothing', async () => {
      const { service, updates } = makeService();
      await expect(service.reorderChannels('ws1', MEMBER, ['b', 'a', 'c'])).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(updates).toEqual([]);
    });

    it('refuses an id that is not a visible salon of the community', async () => {
      const { service, updates } = makeService();
      await expect(service.reorderChannels('ws1', MANAGER, ['a', 'p'])).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(service.reorderChannels('ws1', MANAGER, ['a', 'zzz'])).rejects.toBeInstanceOf(
        BadRequestException
      );
      expect(updates).toEqual([]);
    });

    it('refuses a duplicated id', async () => {
      const { service } = makeService();
      await expect(service.reorderChannels('ws1', MANAGER, ['a', 'a'])).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  describe('sortChannels', () => {
    it('orders by position, then age, then id', () => {
      const rows = [
        { id: 'z', sortOrder: 1, createdAt: t(1) },
        { id: 'y', sortOrder: 0, createdAt: t(9) },
        { id: 'x', sortOrder: 0, createdAt: t(2) },
      ];
      expect(sortChannels(rows).map((r) => r.id)).toEqual(['x', 'y', 'z']);
    });
  });

  describe('a salon name is a display string', () => {
    it('is born as the accented default', () => {
      expect(DEFAULT_CHANNEL_NAME).toBe('général');
    });

    it('round-trips case, accents, emoji and spaces exactly on creation', async () => {
      const { service, saved } = makeService();
      const result = await service.createChannel({
        workspaceId: 'ws1',
        name: `  ${FREE_NAME}  `,
        actorUserId: MANAGER,
      } as never);
      expect(saved[0].name).toBe(FREE_NAME);
      expect(saved[0].sortOrder).toBe(4);
      expect(result.name).toBe(FREE_NAME);
    });

    it('round-trips exactly on rename', async () => {
      const { service, channelRepo } = makeService();
      const result = await service.renameChannel('a', MANAGER, FREE_NAME);
      expect(result.name).toBe(FREE_NAME);
      expect(channelRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: FREE_NAME }));
    });

    it('keeps only sensible limits', () => {
      expect(() => validateChannelName('   ')).toThrow(BadRequestException);
      expect(() => validateChannelName('a'.repeat(81))).toThrow(BadRequestException);
      expect(() => validateChannelName('bad\u0007name')).toThrow(BadRequestException);
      expect(validateChannelName('🎉'.repeat(80))).toBe('🎉'.repeat(80));
    });
  });
});
