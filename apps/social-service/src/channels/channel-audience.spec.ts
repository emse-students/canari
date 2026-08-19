import { Repository } from 'typeorm';
import { ChannelService, channelIsReadableBy } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * WHO A CHANNEL EVENT REACHES.
 *
 * Every event a channel emits used to be addressed to the whole community, because the audience was
 * read off the CONTAINER (`getWorkspaceMemberIds`) while the access check only ever ran on the
 * ACTOR. For a private salon that put its ciphertext, its typing, its pins and its poll tallies on
 * the socket of members the same server refuses to serve it over REST - and since a Graine seed
 * travels on the COMMUNITY's distribution group, those members already held the key that opens it.
 *
 * Nothing here tests a refusal, which is what made the gap invisible: the leak was in the list of
 * addressees, and the only assertion that catches it is on that list.
 */
describe('channel audience', () => {
  const OUTSIDER = 'outsider';
  const INSIDER = 'insider';
  const ADMIN = 'admin';

  /** A private salon `insider` and `admin` may read, and `outsider` may not. */
  const privateChannel = {
    id: 'ch-staff',
    workspaceId: 'ws1',
    name: 'staff',
    isPrivate: true,
    allowedUsers: [INSIDER],
    writePolicy: 'everyone' as const,
    archived: false,
  };

  const publicChannel = {
    id: 'ch-general',
    workspaceId: 'ws1',
    name: 'general',
    isPrivate: false,
    allowedUsers: [] as string[],
    writePolicy: 'everyone' as const,
    archived: false,
  };

  const roster = [
    { userId: INSIDER, roleIds: ['r-member'] },
    { userId: OUTSIDER, roleIds: ['r-member'] },
    { userId: ADMIN, roleIds: ['r-admin'] },
  ];

  const roles = [
    { id: 'r-admin', workspaceId: 'ws1', permissions: ['workspace.manage'], priority: 10 },
    { id: 'r-member', workspaceId: 'ws1', permissions: ['member.invite'], priority: 1 },
  ];

  function makeService(channel: Partial<Channel>) {
    const workspaceRepo = { findOne: jest.fn(() => Promise.resolve({ id: 'ws1', slug: 'ws' })) };
    const channelRepo = { findOne: jest.fn(() => Promise.resolve(channel)), save: jest.fn() };
    // Honours `In([...])`: several guards resolve one member's permissions with it, and a mock that
    // ignores the filter hands every role to every user - which silently turns an outsider into an
    // admin and makes a refusal test pass for the wrong reason.
    const roleRepo = {
      find: jest.fn((q?: { where?: { id?: { _value?: string[] } } }) => {
        const wanted = q?.where?.id?._value;
        return Promise.resolve(wanted ? roles.filter((r) => wanted.includes(r.id)) : roles);
      }),
      findOne: jest.fn(),
    };
    const memberRepo = {
      find: jest.fn(() => Promise.resolve(roster)),
      findOne: jest.fn((q: { where: { userId: string } }) =>
        Promise.resolve(roster.find((m) => m.userId === q.where.userId) ?? null)
      ),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const messageRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ ...x, id: 'msg-1' })),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'msg-1', channelId: channel.id, authorId: INSIDER, pinned: false })
      ),
    };
    const redis = { publishChannelEvent: jest.fn(() => Promise.resolve()) };

    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      { findOne: jest.fn() } as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    return { service, redis, channelRepo, memberRepo, messageRepo };
  }

  /** The addressee list of the first event of `type`, or null when none was published. */
  function audienceOf(redis: { publishChannelEvent: jest.Mock }, type: string): string[] | null {
    const call = redis.publishChannelEvent.mock.calls.find((c) => c[0] === type);
    return call ? (call[2] as string[]) : null;
  }

  /** Lets the fire-and-forget publish inside `sendMessage` settle. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  describe('the rule itself', () => {
    it('lets every member into a public channel, listed or not', () => {
      expect(channelIsReadableBy(publicChannel, OUTSIDER, false)).toBe(true);
    });

    it('lets a listed user into a private channel', () => {
      expect(channelIsReadableBy(privateChannel, INSIDER, false)).toBe(true);
    });

    it('lets an admin into a private channel they were never added to', () => {
      expect(channelIsReadableBy(privateChannel, OUTSIDER, true)).toBe(true);
    });

    it('keeps an unlisted non-admin out of a private channel', () => {
      expect(channelIsReadableBy(privateChannel, OUTSIDER, false)).toBe(false);
    });

    it('compares user ids case-insensitively, as the grant stored them', () => {
      expect(channelIsReadableBy(privateChannel, ' INSIDER ', false)).toBe(true);
    });
  });

  describe('a message in a private channel', () => {
    it('is not addressed to a member who cannot read the channel', async () => {
      const { service, redis } = makeService(privateChannel);

      await service.sendMessage('ch-staff', {
        senderId: INSIDER,
        ciphertext: 'AAAA',
        nonce: 'BBBB',
        senderSessionId: 's-1',
        messageIndex: 0,
        silent: true,
      } as never);
      await flush();

      const audience = audienceOf(redis, 'channel.message.created');
      expect(audience).not.toContain(OUTSIDER);
      expect(audience).toEqual(expect.arrayContaining([INSIDER, ADMIN]));
    });

    it('still reaches every member when the channel is public', async () => {
      const { service, redis } = makeService(publicChannel);

      await service.sendMessage('ch-general', {
        senderId: INSIDER,
        ciphertext: 'AAAA',
        nonce: 'BBBB',
        senderSessionId: 's-1',
        messageIndex: 0,
        silent: true,
      } as never);
      await flush();

      expect(audienceOf(redis, 'channel.message.created')).toEqual([INSIDER, OUTSIDER, ADMIN]);
    });
  });

  describe('everything else a private channel emits', () => {
    it('keeps typing off an outsider socket', async () => {
      const { service, redis } = makeService(privateChannel);
      await service.publishTyping('ch-staff', INSIDER, true);
      expect(audienceOf(redis, 'channel.typing')).not.toContain(OUTSIDER);
    });

    it('keeps a pin off an outsider socket', async () => {
      const { service, redis } = makeService(privateChannel);
      await service.setMessagePinned('ch-staff', 'msg-1', INSIDER, true);
      expect(audienceOf(redis, 'channel.pin')).not.toContain(OUTSIDER);
    });

    it('keeps a deletion off an outsider socket', async () => {
      const { service, redis } = makeService(privateChannel);
      await service.deleteChannelMessage('ch-staff', 'msg-1', INSIDER);
      expect(audienceOf(redis, 'channel.message.deleted')).not.toContain(OUTSIDER);
    });

    it('does not tell the community that a private salon was renamed', async () => {
      const { service, redis } = makeService({ ...privateChannel, allowedUsers: [INSIDER] });
      await service.renameChannel('ch-staff', ADMIN, 'backstage');
      expect(audienceOf(redis, 'channel.updated')).not.toContain(OUTSIDER);
    });
  });

  describe('the roster of a private salon is part of the salon', () => {
    it('refuses its access settings to a member who cannot read it', async () => {
      const { service } = makeService(privateChannel);
      await expect(service.getChannelAccess('ch-staff', OUTSIDER)).rejects.toThrow(
        'Not allowed to access this channel'
      );
    });

    it('serves them to someone who can', async () => {
      const { service } = makeService(privateChannel);
      await expect(service.getChannelAccess('ch-staff', INSIDER)).resolves.toMatchObject({
        allowedUsers: [INSIDER],
      });
    });
  });

  describe('losing access is the one event its subject must receive', () => {
    it('notifies the removed user even though the audience no longer holds them', async () => {
      const { service, redis } = makeService({ ...privateChannel, allowedUsers: [INSIDER] });

      await service.removeMemberFromChannel('ch-staff', INSIDER, ADMIN);

      const audience = audienceOf(redis, 'channel.member.removed');
      expect(audience).toContain(INSIDER);
      expect(audience).not.toContain(OUTSIDER);
    });
  });
});
