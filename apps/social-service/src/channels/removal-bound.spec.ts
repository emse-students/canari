import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { installRemovalLock } from './removal-lock.fixture-spec';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import {
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
} from './permissions';

/**
 * REMOVALS ARE BOUNDED BY THE ACTOR'S OWN PERMISSIONS.
 *
 * Removing a member from the community (`kickFromWorkspace`) or from a private salon
 * (`removeMemberFromChannel`) asks `member.kick`, `channel.manage` or `workspace.manage` of the
 * actor, and then - the same bound every role change asks (`permissionsCover`) - that the target's
 * roles grant nothing the actor does not hold. `workspace.manage` holds everything.
 */
describe('removals bounded by the actor', () => {
  const WS = 'ws-1';
  const SALON = 'salon-1';
  const P = CHANNEL_PERMISSIONS;

  function makeService(
    salon: { isPrivate: boolean; allowedUsers?: string[] } = { isPrivate: true }
  ) {
    const roles = [
      {
        id: 'r-admin',
        name: 'Administrateur',
        priority: 100,
        permissions: DEFAULT_ADMIN_PERMISSIONS,
      },
      { id: 'r-mod', name: 'Modérateur', priority: 50, permissions: DEFAULT_MODERATOR_PERMISSIONS },
      { id: 'r-salons', name: 'Salons', priority: 30, permissions: [P.MANAGE_CHANNEL] },
      { id: 'r-member', name: 'Membre', priority: 10, permissions: [] },
    ].map((r) => ({ ...r, workspaceId: WS })) as ChannelRole[];
    const members = [
      { userId: 'u-admin', roleIds: ['r-admin'] },
      { userId: 'u-admin-2', roleIds: ['r-admin'] },
      { userId: 'u-mod', roleIds: ['r-mod'] },
      { userId: 'u-mod-2', roleIds: ['r-mod'] },
      { userId: 'u-salons', roleIds: ['r-salons'] },
      { userId: 'u-member', roleIds: ['r-member'] },
    ].map((m) => ({ ...m, workspaceId: WS })) as ChannelMember[];

    const workspaceRepo = { findOne: jest.fn().mockResolvedValue({ id: WS, slug: 'ws' }) };
    // ONE row, mutated by every save, so a sequence of edits reads its own previous result.
    const channel = {
      id: SALON,
      workspaceId: WS,
      name: 'prive',
      isPrivate: salon.isPrivate,
      allowedUsers: salon.allowedUsers ?? (salon.isPrivate ? members.map((m) => m.userId) : []),
    };
    const channelRepo = {
      findOne: jest.fn(() => Promise.resolve({ ...channel })),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((c: typeof channel) => {
        Object.assign(channel, c);
        return Promise.resolve(c);
      }),
    };
    const roleRepo = {
      find: jest.fn(
        ({ where }: { where: { id?: FindOperator<string[]>; workspaceId?: string } }) => {
          if (where.id) {
            const ids = where.id.value as unknown as string[];
            return Promise.resolve(roles.filter((r) => ids.includes(r.id)));
          }
          return Promise.resolve(roles);
        }
      ),
      findOne: jest.fn(),
    };
    const memberRepo = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(members.find((m) => m.userId === where.userId) ?? null)
      ),
      find: jest.fn(() => Promise.resolve(members)),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
      save: jest.fn((m: unknown) => Promise.resolve(m)),
    };
    const removalLock = installRemovalLock({ memberRepo, roleRepo, channelRepo });
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    // The key-distribution cut-offs call chat-delivery; what is asserted here is only whether the
    // removal went through.
    for (const name of [
      'cutOffKeyDistribution',
      'cutOffEveryPrivateChannel',
      'cutOffChannelKeyDistribution',
      'evictFromChannelGroup',
      'hardDeleteWorkspace',
      'ensureChannelDistributionGroup',
      'retireChannelDistributionGroup',
    ]) {
      jest.spyOn(service as never, name as never).mockResolvedValue(undefined as never);
    }
    jest.spyOn(service as never, 'channelAudience' as never).mockResolvedValue([] as never);
    jest
      .spyOn(service as never, 'announceChannelAccessGranted' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'writeDecisionsFor' as never)
      .mockResolvedValue(new Map() as never);
    return { service, memberRepo, channelRepo, removalLock };
  }

  beforeEach(() => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  /** The typed code of a refusal, or `'allowed'` when the call went through. */
  const outcome = async (call: Promise<unknown>): Promise<unknown> => {
    try {
      await call;
      return 'allowed';
    } catch (e) {
      return e instanceof ForbiddenException
        ? (e.getResponse() as { code?: unknown }).code
        : String(e);
    }
  };
  const BOUND = 'REMOVAL_EXCEEDS_ACTOR';

  describe('from the community', () => {
    it('refuses removing a member whose roles grant more than the actor holds', async () => {
      const { service, memberRepo } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-admin-2', 'u-mod'))).toBe(BOUND);
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('lets a moderator remove a peer or a plain member', async () => {
      const { service } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-mod-2', 'u-mod'))).toBe('allowed');
      expect(await outcome(service.kickFromWorkspace(WS, 'u-member', 'u-mod'))).toBe('allowed');
    });

    it('lets an administrator remove anyone', async () => {
      const { service } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-mod', 'u-admin'))).toBe('allowed');
    });
  });

  describe('from a private salon', () => {
    it('refuses removing a member whose roles grant more than the actor holds', async () => {
      // A salon manager holds `channel.manage` only; a moderator carries `member.kick` and more.
      const { service, channelRepo } = makeService();
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-mod', 'u-salons'))).toBe(
        BOUND
      );
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('lets a salon manager remove a plain member, and an administrator anyone', async () => {
      const { service } = makeService();
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-member', 'u-salons'))).toBe(
        'allowed'
      );
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-mod', 'u-admin'))).toBe(
        'allowed'
      );
    });
  });

  describe('by rewriting the access list of a private salon', () => {
    const everyoneBut = (...out: string[]) =>
      ['u-admin', 'u-admin-2', 'u-mod', 'u-mod-2', 'u-salons', 'u-member'].filter(
        (u) => !out.includes(u)
      );

    it('refuses dropping a member whose roles grant more than the actor holds', async () => {
      // The same removal, reached through the allowlist instead of the remove button.
      const { service, channelRepo } = makeService();
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod')))
      ).toBe(BOUND);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('lets a salon manager drop a plain member', async () => {
      const { service, channelRepo } = makeService();
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-member')))
      ).toBe('allowed');
      expect(channelRepo.save).toHaveBeenCalled();
    });

    it('skips an allowlist entry who is no longer a member of the community', async () => {
      const { service, channelRepo } = makeService({
        isPrivate: true,
        allowedUsers: ['u-salons', 'u-member', 'u-gone'],
      });
      expect(
        await outcome(
          service.updateChannelAccess(SALON, 'u-salons', true, ['u-salons', 'u-member'])
        )
      ).toBe('allowed');
      expect(channelRepo.save).toHaveBeenCalled();
    });

    it('checks, cuts off and saves under the community removal lock', async () => {
      const { service, removalLock } = makeService();
      await service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-member'));
      expect(removalLock.lockQueries).toEqual([expect.stringContaining('pg_advisory_xact_lock')]);
    });
  });

  describe('by making a public salon private', () => {
    const everyoneBut = (...out: string[]) =>
      ['u-admin', 'u-admin-2', 'u-mod', 'u-mod-2', 'u-salons', 'u-member'].filter(
        (u) => !out.includes(u)
      );

    it('refuses leaving out a member whose roles grant more than the actor holds', async () => {
      // Every community member sees a public salon; going private takes it from whoever is left off.
      const { service, channelRepo } = makeService({ isPrivate: false });
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod')))
      ).toBe(BOUND);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('refuses it through a detour by public, from a private salon that listed them', async () => {
      const { service } = makeService();
      expect(await outcome(service.updateChannelAccess(SALON, 'u-salons', false, []))).toBe(
        'allowed'
      );
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod')))
      ).toBe(BOUND);
    });

    it('lets a salon manager leave out plain members, and an administrator anyone', async () => {
      const salonManager = makeService({ isPrivate: false });
      expect(
        await outcome(
          salonManager.service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-member'))
        )
      ).toBe('allowed');
      const admin = makeService({ isPrivate: false });
      expect(await outcome(admin.service.updateChannelAccess(SALON, 'u-admin', true, []))).toBe(
        'allowed'
      );
    });
  });

  describe('a removal target who is not a member', () => {
    it('is refused as not found when removed from the community', async () => {
      const { service, memberRepo } = makeService();
      await expect(service.kickFromWorkspace(WS, 'u-ghost', 'u-admin')).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });
  });
});
