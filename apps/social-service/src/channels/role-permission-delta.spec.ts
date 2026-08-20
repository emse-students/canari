import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import { CHANNEL_PERMISSIONS } from './permissions';

/**
 * Two administrators editing one role, and the write that made that safe.
 *
 * MEASURED ON PRODUCTION 2026-08-20 (COMM-20). Clicking a cell in the permission grid IS a delta -
 * "grant this one key" - and it was sent as the role's ENTIRE list, computed from whatever the
 * browser happened to be holding. Two administrators toggling two DIFFERENT permissions of one role
 * at the same moment therefore did not race: the second write carried a list built before the first
 * one landed and erased it. The loser's grid then showed a permission the server had dropped AND one
 * it had never stored, indefinitely, with nothing anywhere to say so.
 *
 * TWO EDITS THAT COMMUTE MUST BE SENT AS THE OPERATIONS THEY ARE - which is what the test below is:
 * the two writes are interleaved deliberately, and both survive. Optimistic concurrency would have
 * been the other answer and a worse one, since it turns two compatible edits into a conflict a
 * person has to resolve.
 */
describe('ChannelService.setRoleBasePermission - one key at a time', () => {
  const WORKSPACE = 'ws-1';
  const ROLE = 'r-moderator';
  const ADMIN = 'u-admin';
  const OTHER_ADMIN = 'u-admin-2';

  const ADMIN_ROLE = {
    id: 'r-admin',
    workspaceId: WORKSPACE,
    name: 'Administrateur',
    permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE, CHANNEL_PERMISSIONS.MANAGE_ROLES],
  };

  function makeService() {
    const role = {
      id: ROLE,
      workspaceId: WORKSPACE,
      name: 'Moderateur',
      priority: 50,
      permissions: [
        CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.KICK_MEMBERS,
      ] as string[],
    };
    const roleRepo = {
      findOne: jest.fn((opts: { where: { id: string } }) =>
        Promise.resolve(opts.where.id === ROLE ? role : ADMIN_ROLE)
      ),
      find: jest.fn().mockResolvedValue([ADMIN_ROLE]),
      save: jest.fn((r: Record<string, unknown>) => Promise.resolve(r)),
    };
    const memberRepo = {
      findOne: jest.fn((opts: { where: { userId: string } }) =>
        Promise.resolve({
          workspaceId: WORKSPACE,
          userId: opts.where.userId,
          roleIds: [ADMIN_ROLE.id],
        })
      ),
      find: jest.fn().mockResolvedValue([
        { workspaceId: WORKSPACE, userId: ADMIN, roleIds: [ADMIN_ROLE.id] },
        { workspaceId: WORKSPACE, userId: OTHER_ADMIN, roleIds: [ADMIN_ROLE.id] },
      ]),
      save: jest.fn(),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };

    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      noop as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, redis, role };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * THE CASE THE WHOLE-LIST WRITE LOST. Both administrators act; one revokes, the other grants, and
   * the row afterwards carries BOTH decisions. Under the old shape the second write's list - built
   * before the first one landed - would have put `channel.moderate` back.
   */
  it('keeps both edits when two administrators change one role at once', async () => {
    const { service, role } = makeService();

    const first = await service.setRoleBasePermission(
      ROLE,
      ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
      false
    );
    const second = await service.setRoleBasePermission(
      ROLE,
      OTHER_ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_ROLES,
      true
    );

    expect(first.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_MESSAGES);
    expect(second.permissions).toEqual(
      expect.arrayContaining([
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.KICK_MEMBERS,
        CHANNEL_PERMISSIONS.MANAGE_ROLES,
      ])
    );
    expect(second.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_MESSAGES);
    // And the row itself, not merely what was answered.
    expect(role.permissions.sort()).toEqual(
      [
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.KICK_MEMBERS,
        CHANNEL_PERMISSIONS.MANAGE_ROLES,
      ].sort()
    );
  });

  /** Granting twice is granting once - a click that arrives twice must not double the key. */
  it('is idempotent in both directions', async () => {
    const { service } = makeService();

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true);
    const twice = await service.setRoleBasePermission(
      ROLE,
      ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_ROLES,
      true
    );
    expect(twice.permissions.filter((p) => p === CHANNEL_PERMISSIONS.MANAGE_ROLES).length).toBe(1);

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, false);
    const off = await service.setRoleBasePermission(
      ROLE,
      ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_ROLES,
      false
    );
    expect(off.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_ROLES);
  });

  /**
   * EVERY OPEN GRID IN THE COMMUNITY IS DRAWING THIS ROW, so the change is announced to the
   * membership - not to the editor, and not only to administrators: the workspace listing already
   * hands every member the full `roles` array, so this discloses nothing new.
   */
  it('tells the community what the role now grants', async () => {
    const { service, redis } = makeService();

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true);

    const sent = redis.publishChannelEvent.mock.calls.filter(
      ([type]: [string]) => type === 'workspace.role.permissions'
    );
    expect(sent.length).toBe(1);
    expect(sent[0][1]).toMatchObject({ workspaceId: WORKSPACE, roleId: ROLE });
    expect(sent[0][1].permissions).toContain(CHANNEL_PERMISSIONS.MANAGE_ROLES);
    expect(sent[0][2]).toEqual([ADMIN, OTHER_ADMIN]);
  });

  /** A key the server cannot name is a client asking for a capability that does not exist. */
  it('refuses a permission that is not one of the six', async () => {
    const { service } = makeService();
    await expect(
      service.setRoleBasePermission(ROLE, ADMIN, 'channel.access', true)
    ).rejects.toThrow(/Invalid permission/);
  });
});
