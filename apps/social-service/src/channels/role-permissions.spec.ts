import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import { CHANNEL_PERMISSIONS, RETIRED_PERMISSIONS } from './permissions';

/**
 * Writing a role's permissions, and what happens to a key this server no longer has.
 *
 * `channel.access` and `channel.send` were deleted on 2026-08-19 for being enforced nowhere. The
 * fleet is mixed by construction - a packaged client carries its own bundle and no deploy reaches
 * it - so an old client still renders both and sends all eight keys on any toggle. The whole point
 * of the tests below is the DIFFERENCE between that and a client asking for a capability that never
 * existed: the first is dropped and accused, the second still fails the write.
 *
 * This path had no test at all before, which is how the validation could have been turned into a
 * fleet-wide break by a one-line registry edit.
 */
describe('ChannelService.setRoleBasePermissions', () => {
  const ROLE = 'r-1';
  const WORKSPACE = 'ws-1';
  const ACTOR = 'u-admin';

  function makeService() {
    const roleRepo = {
      findOne: jest.fn().mockResolvedValue({ id: ROLE, workspaceId: WORKSPACE, name: 'Membre' }),
      find: jest.fn().mockResolvedValue([{ permissions: [CHANNEL_PERMISSIONS.MANAGE_ROLES] }]),
      save: jest.fn((r: Record<string, unknown>) => Promise.resolve(r)),
    };
    const memberRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ workspaceId: WORKSPACE, userId: ACTOR, roleIds: ['r-admin'] }),
      find: jest.fn().mockResolvedValue([]),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };

    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      noop as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn() } as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, roleRepo, memberRepo };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores exactly the permissions asked for when they all still exist', async () => {
    const { service, roleRepo } = makeService();

    const result = await service.setRoleBasePermissions(ROLE, ACTOR, [
      CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
      CHANNEL_PERMISSIONS.INVITE_MEMBERS,
    ]);

    expect(result.permissions).toEqual(['channel.moderate', 'member.invite']);
    expect(roleRepo.save).toHaveBeenCalled();
  });

  it('drops a retired key instead of failing the whole edit, and says an old client sent it', async () => {
    // The two retired keys are exactly what an old client still puts in the grid. Refusing the list
    // would turn every role edit on that client into a 400 over rows this server used to draw.
    const { service, roleRepo } = makeService();

    const result = await service.setRoleBasePermissions(ROLE, ACTOR, [
      'channel.access',
      'channel.send',
      CHANNEL_PERMISSIONS.INVITE_MEMBERS,
    ]);

    expect(result.permissions).toEqual(['member.invite']);
    expect(roleRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['member.invite'] })
    );
    expect(
      (service['logger'].warn as jest.Mock).mock.calls.map((c) => String(c[0]))
    ).toContainEqual(expect.stringContaining('RETIRED_PERMISSION_SENT'));
  });

  it('still refuses a key that never existed, and writes nothing', async () => {
    const { service, roleRepo } = makeService();

    await expect(
      service.setRoleBasePermissions(ROLE, ACTOR, ['channel.launch_missiles'])
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(roleRepo.save).not.toHaveBeenCalled();
  });

  it('refuses an actor without MANAGE_ROLES before looking at the keys at all', async () => {
    const { service, roleRepo } = makeService();
    roleRepo.find.mockResolvedValue([{ permissions: [CHANNEL_PERMISSIONS.INVITE_MEMBERS] }]);

    await expect(
      service.setRoleBasePermissions(ROLE, ACTOR, [CHANNEL_PERMISSIONS.MANAGE_MESSAGES])
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(roleRepo.save).not.toHaveBeenCalled();
  });

  it('has no retired key that is also a live one, or the drop would silently delete a real grant', async () => {
    // A guard on the two lists rather than on a call: the day a retired name is reused for a new
    // permission, every write of it would be swallowed by the branch above with only a warning.
    const live = Object.values(CHANNEL_PERMISSIONS) as string[];
    expect(RETIRED_PERMISSIONS.filter((p) => live.includes(p))).toEqual([]);
  });
});
