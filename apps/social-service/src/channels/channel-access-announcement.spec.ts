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

/**
 * A CREATION IS A GRANT, AND IT HAS TO ANNOUNCE ITSELF LIKE EVERY OTHER GRANT HERE.
 *
 * MEASURED ON PRODUCTION 2026-08-21 (COMM-25). The owner's phone, unlocked and online, did a full
 * workspace load and joined the distribution group of all three private salons that existed at that
 * instant. A fourth was created nine seconds later and the phone never heard of it: the only ways
 * into a private salon's group are a full workspace load - post-login, the `online` event, a deep
 * link - and `channel.member.joined`, and `createChannel` published nothing at all.
 *
 * The three sibling grants (an accepted invite, an admin join, an added member) each publish to
 * `channelAudience` AFTER writing `allowedUsers`, so the newly-admitted person is inside the
 * audience rather than the one it misses. This asserts creation now does the same, and that the
 * audience is still derived from ACCESS - a private salon reaches its roster, a public one the
 * community.
 */
describe('ChannelService.createChannel - a creation is a grant', () => {
  const WORKSPACE = 'ws-1';
  const OWNER = 'u-admin';
  const MEMBER = 'u-member';

  const OWNER_ROLE = {
    id: 'r-admin',
    workspaceId: WORKSPACE,
    name: 'Administrateur',
    permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE, CHANNEL_PERMISSIONS.MANAGE_CHANNEL],
  };

  function makeService() {
    const saved: Record<string, unknown>[] = [];
    const channelRepo = {
      create: jest.fn((c: Record<string, unknown>) => ({ ...c })),
      save: jest.fn((c: Record<string, unknown>) => {
        const row = { ...c, id: 'ch-new' };
        saved.push(row);
        return Promise.resolve(row);
      }),
      findOne: jest.fn(),
      delete: jest.fn(),
    };
    const memberRepo = {
      findOne: jest.fn((opts: { where: { userId: string } }) =>
        Promise.resolve(
          opts.where.userId === OWNER
            ? { workspaceId: WORKSPACE, userId: OWNER, roleIds: [OWNER_ROLE.id] }
            : { workspaceId: WORKSPACE, userId: MEMBER, roleIds: [] }
        )
      ),
      find: jest.fn().mockResolvedValue([
        { workspaceId: WORKSPACE, userId: OWNER, roleIds: [OWNER_ROLE.id] },
        { workspaceId: WORKSPACE, userId: MEMBER, roleIds: [] },
      ]),
      save: jest.fn(),
    };
    const roleRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([OWNER_ROLE]),
      save: jest.fn(),
    };
    const workspaceRepo = {
      findOne: jest.fn().mockResolvedValue({ id: WORKSPACE, slug: 'ws', name: 'Workspace' }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };

    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, redis };
  }

  const previousSecret = process.env.INTERNAL_SECRET;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // A private salon MINTS ITS GROUP on the way through, and that call may abort the creation - so
    // it is answered here or the test fails on an unreachable key service instead of on the
    // announcement it is about.
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

  /** Every `channel.member.joined` publish, as `[data, audience]` pairs. */
  const joins = (redis: { publishChannelEvent: jest.Mock }) =>
    redis.publishChannelEvent.mock.calls
      .filter(([type]: [string]) => type === 'channel.member.joined')
      .map(([, data, audience]: [string, Record<string, unknown>, string[]]) => ({
        data,
        audience,
      }));

  /**
   * THE DEFECT ITSELF. The creator holds more than one device and only the one that made the salon
   * knows it exists; the audience is by USER, so naming them is what reaches the others.
   */
  it('announces a private salon to its roster, which is the creator alone', async () => {
    const { service, redis } = makeService();

    await service.createChannel({
      workspaceId: WORKSPACE,
      actorUserId: OWNER,
      name: 'c25',
      visibility: 'private',
    } as Parameters<typeof service.createChannel>[0]);

    const sent = joins(redis);
    expect(sent.length).toBe(1);
    expect(sent[0].audience).toEqual([OWNER]);
    expect(sent[0].data).toMatchObject({
      channelId: 'ch-new',
      channelName: 'c25',
      workspaceId: WORKSPACE,
      visibility: 'private',
    });
  });

  /**
   * THE NEGATIVE CONTROL ON THE AUDIENCE, and the half with no MLS consequence: a public salon has
   * no group of its own, so nothing fails to decrypt - it simply did not appear for anybody until
   * their next workspace load. An audience derived from access rather than from the container is
   * what makes the two answers differ.
   */
  it('announces a public salon to the whole community', async () => {
    const { service, redis } = makeService();

    await service.createChannel({
      workspaceId: WORKSPACE,
      actorUserId: OWNER,
      name: 'general',
      visibility: 'public',
    } as Parameters<typeof service.createChannel>[0]);

    const sent = joins(redis);
    expect(sent.length).toBe(1);
    expect(sent[0].audience).toEqual([OWNER, MEMBER]);
    expect(sent[0].data).toMatchObject({ visibility: 'public', channelName: 'general' });
  });
});
