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
 * Telling a member that their own role changed.
 *
 * MEASURED ON PRODUCTION 2026-08-20 (COMM-5) BEFORE ANY OF THIS EXISTED: a role change reached the
 * other device never. A promoted moderator could not moderate until they reloaded, and - the
 * direction that matters - a DEMOTED administrator went on being offered every control they had
 * just lost for as long as their tab stayed open. Nothing was breakable, because the server
 * re-checks each of those actions; what the person got was buttons that now fail silently.
 *
 * The two properties worth protecting are both about ADDRESSING, and neither is visible from the
 * happy path: the event goes to the member it is about and to nobody else, and a failure to
 * announce must not undo a role that has already been written.
 */
describe('ChannelService.updateWorkspaceMemberRole - announcing it to the member', () => {
  const WORKSPACE = 'ws-1';
  const ACTOR = 'u-admin';
  const TARGET = 'u-target';

  const ADMIN_ROLE = {
    id: 'r-admin',
    workspaceId: WORKSPACE,
    name: 'Administrateur',
    permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE, CHANNEL_PERMISSIONS.MANAGE_ROLES],
  };
  const MEMBER_ROLE = {
    id: 'r-member',
    workspaceId: WORKSPACE,
    name: 'Membre',
    permissions: [] as string[],
  };

  function makeService(targetRole: typeof ADMIN_ROLE | typeof MEMBER_ROLE) {
    const roleRepo = {
      // `findOne` resolves the role being ASSIGNED; `find` resolves the ACTOR's roles, which is
      // what the permission guard reads.
      findOne: jest.fn().mockResolvedValue(targetRole),
      find: jest.fn().mockResolvedValue([ADMIN_ROLE]),
      save: jest.fn((r: Record<string, unknown>) => Promise.resolve(r)),
    };
    const memberRepo = {
      findOne: jest.fn((opts: { where: { userId: string } }) =>
        Promise.resolve({
          workspaceId: WORKSPACE,
          userId: opts.where.userId,
          roleIds: [opts.where.userId === ACTOR ? ADMIN_ROLE.id : MEMBER_ROLE.id],
        })
      ),
      // Two administrators exist, so a demotion is never the last-admin refusal - that guard has
      // its own tests and would otherwise swallow every case here.
      find: jest.fn().mockResolvedValue([
        { userId: ACTOR, roleIds: [ADMIN_ROLE.id] },
        { userId: 'u-other-admin', roleIds: [ADMIN_ROLE.id] },
      ]),
      save: jest.fn((m: Record<string, unknown>) => Promise.resolve(m)),
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
    return { service, redis, memberRepo };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('announces a promotion to the promoted member, and to nobody else', async () => {
    const { service, redis } = makeService(ADMIN_ROLE);

    await service.updateWorkspaceMemberRole(WORKSPACE, TARGET, 'admin', ACTOR);

    expect(redis.publishChannelEvent).toHaveBeenCalledTimes(1);
    const [type, data, recipients] = redis.publishChannelEvent.mock.calls[0];
    expect(type).toBe('workspace.role.changed');
    // ADDRESSED, not broadcast: every other member of the community learns nothing, because their
    // own capabilities did not move and a role is not public business.
    expect(recipients).toEqual([TARGET]);
    expect(data).toEqual({
      workspaceId: WORKSPACE,
      userId: TARGET,
      roleName: 'Administrateur',
      permissions: ADMIN_ROLE.permissions,
      canManage: true,
      changedBy: ACTOR,
    });
  });

  // THE DIRECTION THIS FEATURE EXISTS FOR. A promotion arriving late is an annoyance; a demotion
  // arriving late leaves somebody holding controls they no longer have.
  it('announces a demotion with canManage false, which is the whole point', async () => {
    const { service, redis } = makeService(MEMBER_ROLE);

    await service.updateWorkspaceMemberRole(WORKSPACE, TARGET, 'member', ACTOR);

    const [, data, recipients] = redis.publishChannelEvent.mock.calls[0];
    expect(recipients).toEqual([TARGET]);
    expect(data).toMatchObject({ roleName: 'Membre', canManage: false, permissions: [] });
  });

  // BEST-EFFORT, AND IT MUST STAY THAT WAY. The role is already written when the announcement is
  // attempted, so a throw here would report a failure for a change that DID happen - and the member
  // who missed the event is exactly where they were before it existed: correct on their next load.
  it('still succeeds when the announcement itself fails, because the role is already written', async () => {
    const { service, redis, memberRepo } = makeService(MEMBER_ROLE);
    redis.publishChannelEvent.mockRejectedValue(new Error('redis down'));

    await expect(
      service.updateWorkspaceMemberRole(WORKSPACE, TARGET, 'member', ACTOR)
    ).resolves.toEqual({ success: true });
    expect(memberRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET, roleIds: [MEMBER_ROLE.id] })
    );
  });
});
