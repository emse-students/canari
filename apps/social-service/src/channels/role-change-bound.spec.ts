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
 * ROLE CHANGES ARE BOUNDED BY THE ACTOR'S OWN PERMISSIONS.
 *
 * Role management (`role.manage`) lets a member assign roles, create them and edit what they grant.
 * Each of those is a grant, so each asks `actorMayGrantRole`, the definition an invitation asks:
 *
 *  - an assignment may hand out only a role within the actor's permissions, and may not touch a
 *    member whose current roles grant more than the actor holds;
 *  - the permission editor may not add a permission the actor does not hold, nor edit a role that
 *    grants more than the actor holds - their OWN role included, which is how a bound with a hole
 *    for oneself would be walked round;
 *  - a new role may grant only what its creator holds.
 *
 * `workspace.manage` holds every permission, so an administrator keeps all of it.
 */
describe('role changes bounded by the actor', () => {
  const WS = 'ws-1';
  const P = CHANNEL_PERMISSIONS;

  function makeService() {
    const roles: ChannelRole[] = [
      {
        id: 'r-admin',
        name: 'Administrateur',
        priority: 100,
        permissions: DEFAULT_ADMIN_PERMISSIONS,
      },
      { id: 'r-mod', name: 'Modérateur', priority: 50, permissions: DEFAULT_MODERATOR_PERMISSIONS },
      {
        id: 'r-mgr',
        name: 'Gestion',
        priority: 60,
        permissions: [P.MANAGE_ROLES, P.INVITE_MEMBERS, P.MANAGE_MESSAGES],
      },
      { id: 'r-anim', name: 'Animateur', priority: 20, permissions: [P.MANAGE_MESSAGES] },
      { id: 'r-member', name: 'Membre', priority: 10, permissions: [] },
    ].map((r) => ({ ...r, workspaceId: WS, permissions: [...r.permissions] })) as ChannelRole[];
    const members = [
      { userId: 'u-admin', roleIds: ['r-admin'] },
      { userId: 'u-admin-2', roleIds: ['r-admin'] },
      { userId: 'u-mgr', roleIds: ['r-mgr'] },
      { userId: 'u-mod', roleIds: ['r-mod'] },
      { userId: 'u-member', roleIds: ['r-member'] },
    ].map((m) => ({ ...m, id: `m-${m.userId}`, workspaceId: WS })) as ChannelMember[];
    const copy = (r: ChannelRole | undefined) =>
      r ? ({ ...r, permissions: [...r.permissions] } as ChannelRole) : null;

    const roleById = (where: { id?: string; name?: string }) =>
      roles.find((r) => (where.id ? r.id === where.id : r.name === where.name));
    const em = {
      findOne: jest.fn((_e: unknown, opts: { where: { id: string } }) =>
        Promise.resolve(copy(roleById(opts.where)))
      ),
      save: jest.fn((_e: unknown, row: ChannelRole) => {
        const stored = roles.find((r) => r.id === row.id)!;
        stored.permissions = [...row.permissions];
        return Promise.resolve(copy(stored));
      }),
    };
    const roleRepo = {
      manager: { transaction: jest.fn((fn: (m: typeof em) => Promise<unknown>) => fn(em)) },
      find: jest.fn(
        ({ where }: { where: { id?: FindOperator<string[]>; workspaceId?: string } }) => {
          if (where.id) {
            const ids = where.id.value as unknown as string[];
            return Promise.resolve(roles.filter((r) => ids.includes(r.id)).map((r) => copy(r)));
          }
          return Promise.resolve(roles.map((r) => copy(r)));
        }
      ),
      findOne: jest.fn(({ where }: { where: { id?: string; name?: string } }) =>
        Promise.resolve(copy(roleById(where)))
      ),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const memberRepo = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(members.find((m) => m.userId === where.userId) ?? null)
      ),
      find: jest.fn(() => Promise.resolve(members)),
      save: jest.fn((m: unknown) => Promise.resolve(m)),
      // A role assignment is one column update of the row read; it changes the stored row.
      update: jest.fn((where: { id: string }, patch: Partial<ChannelMember>) => {
        const hit = members.filter((m) => m.id === where.id);
        for (const m of hit) Object.assign(m, patch);
        return Promise.resolve({ affected: hit.length });
      }),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      noop as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    const permsOf = (id: string) => roles.find((r) => r.id === id)!.permissions;
    return { service, memberRepo, roleRepo, permsOf };
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
  const BOUND = 'ROLE_CHANGE_EXCEEDS_ACTOR';

  describe('assigning a role', () => {
    it('refuses a role manager handing out a role above their own', async () => {
      const { service, memberRepo } = makeService();
      expect(
        await outcome(service.updateWorkspaceMemberRole(WS, 'u-member', 'Administrateur', 'u-mgr'))
      ).toBe(BOUND);
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a role manager promoting THEMSELVES', async () => {
      const { service, memberRepo } = makeService();
      expect(
        await outcome(service.updateWorkspaceMemberRole(WS, 'u-mgr', 'Administrateur', 'u-mgr'))
      ).toBe(BOUND);
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses changing a member whose role grants more than the actor holds', async () => {
      // Modérateur carries `member.kick`, which this role manager does not.
      const { service, memberRepo } = makeService();
      expect(await outcome(service.updateWorkspaceMemberRole(WS, 'u-mod', 'Membre', 'u-mgr'))).toBe(
        BOUND
      );
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('lets a role manager assign a role within their permissions', async () => {
      const { service } = makeService();
      expect(
        await outcome(service.updateWorkspaceMemberRole(WS, 'u-member', 'Animateur', 'u-mgr'))
      ).toBe('allowed');
    });

    it('lets an administrator assign anything', async () => {
      const { service } = makeService();
      expect(
        await outcome(
          service.updateWorkspaceMemberRole(WS, 'u-member', 'Administrateur', 'u-admin')
        )
      ).toBe('allowed');
    });
  });

  describe('editing what a role grants', () => {
    it('refuses a role manager adding to THEIR OWN role a permission they lack', async () => {
      const { service, permsOf } = makeService();
      expect(
        await outcome(service.setRoleBasePermission('r-mgr', 'u-mgr', P.MANAGE_WORKSPACE, true))
      ).toBe(BOUND);
      expect(permsOf('r-mgr')).not.toContain(P.MANAGE_WORKSPACE);
    });

    it('refuses adding to any role a permission the actor lacks', async () => {
      const { service, permsOf } = makeService();
      expect(
        await outcome(service.setRoleBasePermission('r-anim', 'u-mgr', P.KICK_MEMBERS, true))
      ).toBe(BOUND);
      expect(permsOf('r-anim')).toEqual([P.MANAGE_MESSAGES]);
    });

    it('refuses editing a role that grants more than the actor holds, even to remove', async () => {
      const { service, permsOf } = makeService();
      expect(
        await outcome(service.setRoleBasePermission('r-mod', 'u-mgr', P.MANAGE_MESSAGES, false))
      ).toBe(BOUND);
      expect(permsOf('r-mod')).toContain(P.MANAGE_MESSAGES);
    });

    it('lets a role manager add what they hold, and remove from their own role', async () => {
      const { service, permsOf } = makeService();
      expect(
        await outcome(service.setRoleBasePermission('r-anim', 'u-mgr', P.INVITE_MEMBERS, true))
      ).toBe('allowed');
      expect(permsOf('r-anim')).toContain(P.INVITE_MEMBERS);
      expect(
        await outcome(service.setRoleBasePermission('r-mgr', 'u-mgr', P.MANAGE_MESSAGES, false))
      ).toBe('allowed');
    });

    it('lets an administrator grant anything', async () => {
      const { service, permsOf } = makeService();
      expect(
        await outcome(service.setRoleBasePermission('r-mod', 'u-admin', P.MANAGE_WORKSPACE, true))
      ).toBe('allowed');
      expect(permsOf('r-mod')).toContain(P.MANAGE_WORKSPACE);
    });
  });

  describe('creating a role', () => {
    it('ranks a new role just above the base role, whatever the body says', async () => {
      // The column has no default, so a role saved without one could not be stored at all; and the
      // rank is the server's, because the lowest role is what joining grants and the highest one
      // decides who is promoted when a community loses its last administrator.
      const { service, roleRepo } = makeService();
      await service.createRole({
        workspaceId: WS,
        name: 'Aide',
        priority: 1000,
        permissions: [P.INVITE_MEMBERS],
        actorUserId: 'u-mgr',
      } as never);
      expect(roleRepo.save).toHaveBeenCalledWith(expect.objectContaining({ priority: 11 }));
    });

    it('refuses a role granting what its creator lacks', async () => {
      const { service, roleRepo } = makeService();
      expect(
        await outcome(
          service.createRole({
            workspaceId: WS,
            name: 'Sous-admin',
            permissions: [P.MANAGE_WORKSPACE],
            actorUserId: 'u-mgr',
          } as never)
        )
      ).toBe(BOUND);
      expect(roleRepo.save).not.toHaveBeenCalled();
    });

    it('lets a role manager create a role within their permissions', async () => {
      const { service } = makeService();
      expect(
        await outcome(
          service.createRole({
            workspaceId: WS,
            name: 'Aide',
            permissions: [P.INVITE_MEMBERS],
            actorUserId: 'u-mgr',
          } as never)
        )
      ).toBe('allowed');
    });
  });
});
