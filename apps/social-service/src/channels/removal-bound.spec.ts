import { ForbiddenException, Logger } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { ChannelService } from './channel.service';
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

  function makeService() {
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
    const channelRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: SALON,
        workspaceId: WS,
        name: 'prive',
        isPrivate: true,
        allowedUsers: members.map((m) => m.userId),
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((c: unknown) => Promise.resolve(c)),
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
    // A departure calls chat-delivery around its roster write; what is asserted here is only
    // whether the removal went through, so the departure runs its roster write and nothing else.
    jest.spyOn(service as never, 'departDistributionGroups' as never).mockImplementation((async (
      _cuts: unknown,
      _reason: string,
      _workspaceId: string,
      rosterWrite: (m: unknown) => Promise<void>
    ) =>
      rosterWrite({
        getRepository: (entity: unknown) => (entity === Channel ? channelRepo : memberRepo),
      })) as never);
    for (const name of ['hardDeleteWorkspace']) {
      jest.spyOn(service as never, name as never).mockResolvedValue(undefined as never);
    }
    jest.spyOn(service as never, 'channelAudience' as never).mockResolvedValue([] as never);
    return { service, memberRepo, channelRepo };
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
});
