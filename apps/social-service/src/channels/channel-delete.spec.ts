import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';

/**
 * DELETING A SALON DELETES IT - and there was no test at all while it did not.
 *
 * Until 2026-08-20 this route set `archived = true` and, in the same call, destroyed the group
 * holding the salon's seeds. A private salon therefore ended as ciphertext no client keeps a key
 * for: hidden from every listing, unreachable by every route, with no un-archive anywhere in the
 * service. `deleteWorkspace` had already met that shape and rejected it one scope up - the rows
 * survive as something nobody can read, which is not recoverability.
 *
 * What these tests pin is not "the delete happens" - it is the ORDER and what a failure does to it.
 * The group lives in another service and cannot join the transaction, so the only safe sequence is
 * to destroy it FIRST and let that abort everything: once the row is gone there is nothing left
 * that names the group, and an orphan nobody can name is the shape the 2026-08-17 purge had to
 * find by hand. The opposite order fails silently and looks identical on the happy path, which is
 * exactly why it is asserted here rather than trusted to the reading.
 */
describe('ChannelService.deleteChannel', () => {
  const SECRET = 'internal-secret-for-tests';
  const WORKSPACE = 'ws-1';
  const ADMIN = 'u-admin';
  const INSIDER = 'u-insider';
  const OUTSIDER = 'u-outsider';

  let previousSecret: string | undefined;

  const roles = [
    { id: 'r-admin', workspaceId: WORKSPACE, permissions: ['workspace.manage'], priority: 10 },
    { id: 'r-member', workspaceId: WORKSPACE, permissions: ['member.invite'], priority: 1 },
  ];
  const roster = [
    { userId: ADMIN, roleIds: ['r-admin'] },
    { userId: INSIDER, roleIds: ['r-member'] },
    { userId: OUTSIDER, roleIds: ['r-member'] },
  ];

  const PRIVATE_CHANNEL = {
    id: 'ch-staff',
    workspaceId: WORKSPACE,
    name: 'staff',
    isPrivate: true,
    allowedUsers: [INSIDER],
    writePolicy: 'everyone' as const,
    distributionGroupId: 'g-staff',
  };
  const PUBLIC_CHANNEL = {
    id: 'ch-general',
    workspaceId: WORKSPACE,
    name: 'general',
    isPrivate: false,
    allowedUsers: [] as string[],
    writePolicy: 'everyone' as const,
    distributionGroupId: null,
  };

  /**
   * ONE ORDERED LOG OF EVERYTHING THAT LEAVES THE SERVICE, which is the only way the central
   * assertion can be made at all. Whether the group was destroyed before or after the rows went is
   * invisible in per-mock call counts - both orders call both mocks exactly once.
   */
  let trace: string[];

  function makeService(
    channel: typeof PRIVATE_CHANNEL | typeof PUBLIC_CHANNEL,
    opts: { deliveryOk?: boolean } = {}
  ) {
    process.env.INTERNAL_SECRET = SECRET;
    trace = [];

    const fetchMock = jest.fn((url: string, init: { method?: string }) => {
      trace.push(`delivery ${init?.method ?? 'GET'} ${String(url).split('/').slice(-2).join('/')}`);
      const ok = opts.deliveryOk !== false;
      return Promise.resolve({
        ok,
        status: ok ? 200 : 503,
        text: () => Promise.resolve(JSON.stringify({ deleted: true })),
      } as unknown as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const mgrDelete = jest.fn((entity: unknown, where: Record<string, string>) => {
      const name = (entity as { name?: string })?.name ?? String(entity);
      trace.push(`delete ${name} ${JSON.stringify(where)}`);
      return Promise.resolve({ affected: 1 });
    });

    const channelRepo = {
      findOne: jest.fn(() => Promise.resolve(channel)),
      find: jest.fn(() => Promise.resolve([channel])),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      manager: {
        transaction: jest.fn((fn: (m: { delete: typeof mgrDelete }) => Promise<void>) => {
          trace.push('transaction');
          return fn({ delete: mgrDelete });
        }),
      },
    };
    // Honours `In([...])`, for the reason `channel-audience.spec.ts` gives: a mock that ignores the
    // filter hands every role to every user, and a permission refusal then passes for the wrong
    // reason - which is the one failure mode a deletion test must not have.
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
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = {
      publishChannelEvent: jest.fn((type: string, _data: unknown, _to: string[]) => {
        trace.push(`publish ${type}`);
        return Promise.resolve(undefined);
      }),
    };

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
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, channelRepo, redis, mgrDelete, fetchMock };
  }

  beforeAll(() => {
    previousSecret = process.env.INTERNAL_SECRET;
  });
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  it('deletes the row and its messages instead of flagging them', async () => {
    const { service, channelRepo, mgrDelete } = makeService(PUBLIC_CHANNEL);

    await expect(service.deleteChannel(PUBLIC_CHANNEL.id, ADMIN)).resolves.toEqual({
      success: true,
    });

    expect(mgrDelete).toHaveBeenCalledWith(ChannelMessage, { channelId: PUBLIC_CHANNEL.id });
    expect(mgrDelete).toHaveBeenCalledWith(Channel, { id: PUBLIC_CHANNEL.id });
    // THE OLD BEHAVIOUR, NAMED SO IT CANNOT COME BACK QUIETLY. `save` was how the salon was
    // archived, and a reintroduced `channel.archived = true` beside a delete would pass every other
    // assertion in this file.
    expect(channelRepo.save).not.toHaveBeenCalled();
  });

  it('destroys a private salon key-distribution group BEFORE the rows, never after', async () => {
    const { service } = makeService(PRIVATE_CHANNEL);

    await service.deleteChannel(PRIVATE_CHANNEL.id, ADMIN);

    expect(trace).toEqual([
      'delivery DELETE channel/ch-staff',
      'transaction',
      'delete ChannelMessage {"channelId":"ch-staff"}',
      'delete Channel {"id":"ch-staff"}',
      'publish channel.deleted',
    ]);
  });

  // THE REASON THE ORDER IS THE WAY IT IS. The group lives in chat-delivery and cannot join the
  // transaction, so the only outcome that stays reconcilable is the whole deletion refusing: the
  // salon is still there, still named, and the operator can try again. Deleting first and treating
  // the group as best-effort would leave a group nothing on earth still names.
  it('aborts the whole deletion when the group cannot be destroyed, touching nothing', async () => {
    const { service, mgrDelete, redis, channelRepo } = makeService(PRIVATE_CHANNEL, {
      deliveryOk: false,
    });

    await expect(service.deleteChannel(PRIVATE_CHANNEL.id, ADMIN)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );

    expect(mgrDelete).not.toHaveBeenCalled();
    expect(channelRepo.manager.transaction).not.toHaveBeenCalled();
    // No event either: a client told the salon was deleted would drop it from its sidebar and never
    // ask again, which is worse than the failure it is reporting.
    expect(redis.publishChannelEvent).not.toHaveBeenCalled();
  });

  it('asks chat-delivery for nothing when the salon is public, because it owns no group', async () => {
    const { service, fetchMock } = makeService(PUBLIC_CHANNEL);

    await service.deleteChannel(PUBLIC_CHANNEL.id, ADMIN);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ADDRESSED FROM A ROSTER THAT IS ABOUT TO STOP EXISTING. `channelAudience` reads the salon's own
  // `allowedUsers`, so a snapshot taken after the delete would address nobody - and the members who
  // had it open would keep it on screen until their next load.
  //
  // THE DELETING ADMIN IS NOT IN IT, and that is the 2026-08-19 decision working rather than a bug
  // in this call: an administrator reaches a private salon by JOINING it, not through
  // `workspace.manage`, so one who never joined is not on the roster and gets no event. It costs
  // them a stale sidebar entry until their next load - noted in the backlog, and deliberately not
  // patched here by widening the audience, which would put every private salon's events back on the
  // socket of people the same server refuses to serve it over REST.
  it('addresses the event to the private salon roster, snapshotted before the delete', async () => {
    const { service, redis } = makeService(PRIVATE_CHANNEL);

    await service.deleteChannel(PRIVATE_CHANNEL.id, ADMIN);

    const [type, data, recipients] = redis.publishChannelEvent.mock.calls[0];
    expect(type).toBe('channel.deleted');
    expect(data).toEqual({ channelId: PRIVATE_CHANNEL.id, workspaceId: WORKSPACE });
    expect(recipients).toEqual([INSIDER]);
  });

  it('refuses a member with neither MANAGE_CHANNEL nor MANAGE_WORKSPACE, and deletes nothing', async () => {
    const { service, mgrDelete, fetchMock } = makeService(PUBLIC_CHANNEL);

    await expect(service.deleteChannel(PUBLIC_CHANNEL.id, OUTSIDER)).rejects.toBeInstanceOf(
      ForbiddenException
    );

    expect(mgrDelete).not.toHaveBeenCalled();
    // Checked before anything leaves the service, so a refusal cannot have destroyed a group first.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
