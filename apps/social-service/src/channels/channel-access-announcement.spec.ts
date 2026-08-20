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
 * Telling a salon's audience that its write policy changed.
 *
 * MEASURED ON PRODUCTION 2026-08-20 (COMM-7), TWICE. The first run found the server refusing an
 * ordinary member correctly while the client offered a composer anyway; the fix taught the workspace
 * listing to answer `viewerCanWrite`, and the SECOND run failed identically - because a listing is
 * fetched once and the person changing the rule is not the person holding the stale one. Nothing
 * announced the change, so a member sitting in the salon kept their composer until they reloaded.
 *
 * THE DECISION TRAVELS, NEVER THE POLICY, and that is what forces the shape asserted here: one
 * payload cannot carry a per-viewer verdict, so the audience is SPLIT BY THE ANSWER. A client holds
 * none of the roles it would need to derive the verdict itself, so a broadcast carrying
 * `writePolicy` would be a rule with nobody able to apply it.
 */
describe('ChannelService.updateChannelAccess - announcing the new decision', () => {
  const WORKSPACE = 'ws-1';
  const CHANNEL = 'ch-1';
  const ADMIN = 'u-admin';
  const MEMBER = 'u-member';

  const ADMIN_ROLE = {
    id: 'r-admin',
    workspaceId: WORKSPACE,
    name: 'Administrateur',
    permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE, CHANNEL_PERMISSIONS.MANAGE_CHANNEL],
  };
  const MEMBER_ROLE = {
    id: 'r-member',
    workspaceId: WORKSPACE,
    name: 'Membre',
    permissions: [] as string[],
  };

  function makeService() {
    const channel = {
      id: CHANNEL,
      workspaceId: WORKSPACE,
      name: 'general',
      isPrivate: false,
      allowedUsers: [] as string[],
      writePolicy: 'everyone' as string,
      distributionGroupId: null as string | null,
    };
    const channelRepo = {
      findOne: jest.fn().mockResolvedValue(channel),
      find: jest.fn().mockResolvedValue([channel]),
      save: jest.fn((c: Record<string, unknown>) => Promise.resolve(c)),
    };
    const memberRepo = {
      findOne: jest.fn((opts: { where: { userId: string } }) =>
        Promise.resolve({
          workspaceId: WORKSPACE,
          userId: opts.where.userId,
          roleIds: [opts.where.userId === ADMIN ? ADMIN_ROLE.id : MEMBER_ROLE.id],
        })
      ),
      find: jest.fn().mockResolvedValue([
        { workspaceId: WORKSPACE, userId: ADMIN, roleIds: [ADMIN_ROLE.id] },
        { workspaceId: WORKSPACE, userId: MEMBER, roleIds: [MEMBER_ROLE.id] },
      ]),
      save: jest.fn((m: Record<string, unknown>) => Promise.resolve(m)),
    };
    const roleRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([ADMIN_ROLE, MEMBER_ROLE]),
      save: jest.fn(),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };

    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, redis, channel };
  }

  const previousSecret = process.env.INTERNAL_SECRET;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Making a salon private MINTS ITS GROUP, and that call is allowed to abort the change - so a
    // test about the announcement has to answer it or it fails on an unreachable key service
    // instead of on what it is asking about.
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ groupId: 'g-1', created: true })),
      } as unknown as Response)
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  /** Every `channel.updated` publish, as `[data, audience]` pairs. */
  const announcements = (redis: { publishChannelEvent: jest.Mock }) =>
    redis.publishChannelEvent.mock.calls
      .filter(([type]: [string]) => type === 'channel.updated')
      .map(([, data, audience]: [string, Record<string, unknown>, string[]]) => ({
        data,
        audience,
      }));

  it('sends each half of the audience its own verdict when writing is reserved', async () => {
    const { service, redis, channel } = makeService();

    await service.updateChannelAccess(CHANNEL, ADMIN, false, [], 'admins');

    expect(channel.writePolicy).toBe('admins');
    const sent = announcements(redis);
    const yes = sent.find((s) => s.data.viewerCanWrite === true);
    const no = sent.find((s) => s.data.viewerCanWrite === false);
    expect(yes?.audience).toEqual([ADMIN]);
    expect(no?.audience).toEqual([MEMBER]);
    // The channel is named, because the client applies the verdict to one sidebar row.
    expect(yes?.data).toMatchObject({ channelId: CHANNEL, workspaceId: WORKSPACE });
  });

  /**
   * A POLICY NOBODY IS EXCLUDED BY MUST NOT SEND AN EMPTY AUDIENCE. `publishChannelEvent` addresses
   * an event by naming its recipients, so an empty list is not "nobody" to every reader downstream -
   * and a publish with nothing to say is noise on a bus every connected client reads.
   */
  it('sends one announcement, not two, when the policy excludes nobody', async () => {
    const { service, redis } = makeService();

    await service.updateChannelAccess(CHANNEL, ADMIN, false, [], 'everyone');

    const sent = announcements(redis);
    expect(sent.length).toBe(1);
    expect(sent[0].data.viewerCanWrite).toBe(true);
    expect(sent[0].audience).toEqual([ADMIN, MEMBER]);
  });

  /**
   * THE AUDIENCE OF A PRIVATE SALON IS ITS ROSTER, and it is read AFTER the save - so somebody
   * excluded by the same call is not told what they may do in a salon they can no longer see.
   */
  it('addresses a salon it has just made private to its roster alone', async () => {
    const { service, redis } = makeService();

    await service.updateChannelAccess(CHANNEL, ADMIN, true, [ADMIN], 'everyone');

    const sent = announcements(redis);
    expect(sent.length).toBe(1);
    expect(sent[0].audience).toEqual([ADMIN]);
    expect(sent[0].data).toMatchObject({ isPrivate: true, viewerCanWrite: true });
  });
});
