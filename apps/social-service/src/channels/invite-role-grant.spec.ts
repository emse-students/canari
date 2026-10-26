import { ForbiddenException, Logger } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { fakeDepartureManager } from './departure-transaction.fake-spec';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import {
  actorMayGrantRole,
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  roleGrantsRoleManagement,
} from './permissions';

/**
 * AN INVITATION GRANTS ONLY A ROLE THE INVITER MAY GRANT.
 *
 * `inviteToChannel` takes a role name from its body and, for a newcomer, writes that role. Inviting
 * is `member.invite` (or `channel.manage`); granting a role is role management, which is
 * `role.manage` (or `workspace.manage`). The invitation may therefore grant the community's base
 * role and nothing else, unless the inviter could have granted the role through role management
 * AND the role grants nothing the inviter does not hold. Both halves are `actorMayGrantRole`, the
 * one definition; the base role is the one an invite LINK grants, the lowest-priority role.
 */
describe('the role an invitation grants', () => {
  const CHANNEL = 'ch-1';
  const WORKSPACE = 'ws-1';
  const TARGET = 'u-target';

  const ROLES: ChannelRole[] = [
    {
      id: 'r-admin',
      name: 'Administrateur',
      priority: 100,
      permissions: DEFAULT_ADMIN_PERMISSIONS,
    },
    { id: 'r-mod', name: 'Modérateur', priority: 50, permissions: DEFAULT_MODERATOR_PERMISSIONS },
    {
      id: 'r-rolemgr',
      name: 'Gestion',
      priority: 60,
      permissions: [
        CHANNEL_PERMISSIONS.MANAGE_ROLES,
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
      ],
    },
    {
      id: 'r-anim',
      name: 'Animateur',
      priority: 20,
      permissions: [CHANNEL_PERMISSIONS.MANAGE_MESSAGES],
    },
    {
      id: 'r-salons',
      name: 'Salons',
      priority: 30,
      permissions: [CHANNEL_PERMISSIONS.MANAGE_CHANNEL],
    },
    { id: 'r-member', name: 'Membre', priority: 10, permissions: [] },
  ] as unknown as ChannelRole[];

  /** A service whose actor holds `actorRoleId`, inviting a person who is not yet a member. */
  function makeService(actorRoleId: string, roles: ChannelRole[] = ROLES) {
    const channelRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: CHANNEL,
        workspaceId: WORKSPACE,
        isPrivate: false,
        allowedUsers: [],
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((c: Record<string, unknown>) => Promise.resolve(c)),
      // No block between the two people.
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    const workspaceRepo = { findOne: jest.fn().mockResolvedValue({ id: WORKSPACE, slug: 'ws' }) };
    const memberRepo = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          where.userId === TARGET
            ? null
            : { workspaceId: WORKSPACE, userId: where.userId, roleIds: [actorRoleId] }
        )
      ),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve(x)),
      // An admission re-checks under the removal lock that the community still has members.
      count: jest.fn().mockResolvedValue(1),
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
      findOne: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve(roles.find((r) => r.name === where.name) ?? null)
      ),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    Object.assign(memberRepo, {
      manager: fakeDepartureManager(() => ({ channelRepo, memberRepo, roleRepo })),
    });
    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn(() => Promise.resolve()) } as unknown as RedisService
    );
    return { service, memberRepo };
  }

  const invite = (actorRoleId: string, roleName?: string, roles: ChannelRole[] = ROLES) => {
    const made = makeService(actorRoleId, roles);
    const result = made.service
      .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: 'u-actor', roleName })
      .catch((e: unknown) => e);
    return { ...made, result };
  };

  /** The roles written for the invitee, or `null` when nothing was written. */
  const grantedRoleIds = (memberRepo: { save: jest.Mock }): string[] | null => {
    const call = memberRepo.save.mock.calls.find(
      ([m]: [{ userId: string }]) => m.userId === TARGET
    );
    return call ? (call[0] as { roleIds: string[] }).roleIds : null;
  };

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    // The invitee has a device: the device guard is not what these tests are about.
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ count: 1 })),
      } as unknown as Response)
    ) as never;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** What a refused invitation left: its typed code, and the roles written for the invitee. */
  async function refusal(
    result: Promise<unknown>,
    memberRepo: { save: jest.Mock }
  ): Promise<{ refused: boolean; code: unknown; granted: string[] | null }> {
    const err = await result;
    return {
      refused: err instanceof ForbiddenException,
      code: (err as { getResponse?: () => { code?: unknown } }).getResponse?.()?.code,
      granted: grantedRoleIds(memberRepo),
    };
  }

  const REFUSED = { refused: true, code: 'INVITE_ROLE_NOT_GRANTABLE', granted: null };

  it('refuses an Administrateur grant from a moderator', async () => {
    const { result, memberRepo } = invite('r-mod', 'Administrateur');
    expect(await refusal(result, memberRepo)).toEqual(REFUSED);
  });

  it('refuses a Moderateur grant from a moderator, who cannot manage roles', async () => {
    const { result, memberRepo } = invite('r-mod', 'moderator');
    expect(await refusal(result, memberRepo)).toEqual(REFUSED);
  });

  it('refuses an Administrateur grant from a salon manager', async () => {
    const { result, memberRepo } = invite('r-salons', 'admin');
    expect(await refusal(result, memberRepo)).toEqual(REFUSED);
  });

  it('refuses a role manager a role granting what they do not hold', async () => {
    const admin = invite('r-rolemgr', 'Administrateur');
    expect(await refusal(admin.result, admin.memberRepo)).toEqual(REFUSED);
    // Modérateur carries `member.kick`, which this role manager does not.
    const mod = invite('r-rolemgr', 'Modérateur');
    expect(await refusal(mod.result, mod.memberRepo)).toEqual(REFUSED);
  });

  it('lets a role manager grant a role within their own permissions', async () => {
    const { result, memberRepo } = invite('r-rolemgr', 'Animateur');
    expect(await result).toMatchObject({ success: true });
    expect(grantedRoleIds(memberRepo)).toEqual(['r-anim']);
  });

  it('lets any inviter grant the base role, named or not', async () => {
    const named = invite('r-mod', 'Membre');
    expect(await named.result).toMatchObject({ success: true });
    expect(grantedRoleIds(named.memberRepo)).toEqual(['r-member']);

    const unnamed = invite('r-mod');
    expect(await unnamed.result).toMatchObject({ success: true });
    expect(grantedRoleIds(unnamed.memberRepo)).toEqual(['r-member']);
  });

  it('reads "Membre" as the base role even where Membre is not the lowest one', async () => {
    // Deployed clients send `roleName: 'Membre'` for every ordinary invitation. A community whose
    // lowest role is another one must still let a moderator invite: the request names the base
    // role, and the base role is what it gets.
    const roles = [
      ...ROLES,
      { id: 'r-guest', name: 'Invite', priority: 5, permissions: [] },
    ] as unknown as ChannelRole[];
    const { result, memberRepo } = invite('r-mod', 'Membre', roles);
    expect(await result).toMatchObject({ success: true });
    expect(grantedRoleIds(memberRepo)).toEqual(['r-guest']);
  });

  it('matches the base role by its own name', async () => {
    const roles = [
      ...ROLES,
      { id: 'r-guest', name: 'Invite', priority: 5, permissions: [] },
    ] as unknown as ChannelRole[];
    const { result, memberRepo } = invite('r-mod', 'Invite', roles);
    expect(await result).toMatchObject({ success: true });
    expect(grantedRoleIds(memberRepo)).toEqual(['r-guest']);
  });

  it('lets an administrator grant Administrateur', async () => {
    const { result, memberRepo } = invite('r-admin', 'Administrateur');
    expect(await result).toMatchObject({ success: true });
    expect(grantedRoleIds(memberRepo)).toEqual(['r-admin']);
  });
});

describe('actorMayGrantRole - the one definition of who may hand out a role', () => {
  const P = CHANNEL_PERMISSIONS;

  it('is role management first: without it, nothing beyond the base role', () => {
    expect(roleGrantsRoleManagement([P.INVITE_MEMBERS, P.MANAGE_CHANNEL])).toBe(false);
    expect(actorMayGrantRole([P.INVITE_MEMBERS, P.KICK_MEMBERS], [P.KICK_MEMBERS])).toBe(false);
    expect(actorMayGrantRole([P.MANAGE_CHANNEL], [])).toBe(false);
  });

  it('bounds a role manager by what they hold', () => {
    expect(actorMayGrantRole([P.MANAGE_ROLES, P.KICK_MEMBERS], [P.KICK_MEMBERS])).toBe(true);
    expect(actorMayGrantRole([P.MANAGE_ROLES], [P.KICK_MEMBERS])).toBe(false);
    expect(actorMayGrantRole([P.MANAGE_ROLES], DEFAULT_ADMIN_PERMISSIONS)).toBe(false);
  });

  it('lets workspace.manage grant anything, since it holds every permission', () => {
    expect(roleGrantsRoleManagement([P.MANAGE_WORKSPACE])).toBe(true);
    expect(actorMayGrantRole([P.MANAGE_WORKSPACE], DEFAULT_ADMIN_PERMISSIONS)).toBe(true);
  });
});
