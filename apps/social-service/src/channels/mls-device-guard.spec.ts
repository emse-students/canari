import {
  BadRequestException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { fetchUserDeviceCount } from '../internal/delivery.client';

/**
 * The guard that refuses to invite someone who has never installed Canari, and what it does when it
 * cannot find out.
 *
 * IT USED TO FAIL OPEN. `userHasMlsDevices` returned `true` on a non-2xx, on any thrown error and
 * on an unset secret, so the day its URL was missing the `/api` prefix it was a constant `true` -
 * not a degraded check, no check at all, measured on production 2026-08-14. Every test below exists
 * because none of them existed then: the suite passed just as green with the guard disabled.
 *
 * The two outcomes are kept apart on purpose. "This person has not installed Canari" is advice
 * about them; "the key service is not answering" is a retry about us, and the user is owed the
 * difference.
 *
 * AND IT THEN FAILED CLOSED AGAINST THE WRONG ROUTE, which this suite could not see: `fetch` was
 * stubbed to answer whatever it was asked, so it answered a route chat-delivery serves behind
 * `HeaderAuthGuard` exactly as happily as one it serves to services. Production answered 401 to
 * every direct invitation for a day. **A stub that answers any URL tests everything except the
 * one thing a client call gets wrong**, so the URL is now asserted here, and it is not decoration.
 */
describe('the MLS device guard on an invitation', () => {
  const CHANNEL = 'ch-1';
  const WORKSPACE = 'ws-1';
  const ACTOR = 'u-admin';
  const TARGET = 'u-target';

  function makeService(blockRows: unknown[] = []) {
    // `user_blocks` is core-service's table, read straight out of `auth_db` through this manager.
    // Empty by default: every test here is about the DEVICE guard, and a block would refuse before
    // that guard ever runs.
    const blockQuery = jest.fn().mockResolvedValue(blockRows);
    const channelRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: CHANNEL,
        workspaceId: WORKSPACE,
        isPrivate: false,
        allowedUsers: [],
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((c: Record<string, unknown>) => Promise.resolve(c)),
      manager: { query: blockQuery },
    };
    const workspaceRepo = { findOne: jest.fn().mockResolvedValue({ id: WORKSPACE, slug: 'ws' }) };
    const memberRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ workspaceId: WORKSPACE, userId: ACTOR, roleIds: ['r-admin'] }),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve(x)),
    };
    const roleRepo = {
      find: jest.fn().mockResolvedValue([{ permissions: [CHANNEL_PERMISSIONS.INVITE_MEMBERS] }]),
      findOne: jest.fn().mockResolvedValue({ id: 'r-member', name: 'Membre' }),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };

    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn(() => Promise.resolve()) } as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, memberRepo, channelRepo, blockQuery };
  }

  /** A fetch answering `status` with `body`, standing in for chat-delivery's device route. */
  function delivery(status: number, body: unknown) {
    return jest.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response)
    );
  }

  /** The one URL chat-delivery serves to another service - see the note above the suite. */
  const COUNT_ROUTE = `/api/internal/mls/devices/${TARGET}/count`;

  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  describe('fetchUserDeviceCount', () => {
    it('counts the devices a genuine 200 reported', async () => {
      global.fetch = delivery(200, { count: 2 }) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).resolves.toBe(2);
    });

    it('answers zero for a real zero, which is a fact about the person', async () => {
      global.fetch = delivery(200, { count: 0 }) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).resolves.toBe(0);
    });

    it('asks the route addressed to a service, not the one behind the user guard', async () => {
      // THE ASSERTION THIS SUITE DID NOT HAVE. `mls/devices/:userId` answers the same question
      // behind `HeaderAuthGuard`, which wants headers only Nginx mints - so calling it from a
      // container is a permanent 401, and a stub that answers every URL says nothing about it.
      global.fetch = delivery(200, { count: 1 }) as never;
      await fetchUserDeviceCount('s', TARGET);
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(COUNT_ROUTE);
    });

    it('throws on a non-2xx rather than reporting a device count it was never given', async () => {
      global.fetch = delivery(404, {}) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    });

    it('throws when the call could not be made at all', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    });

    it('throws on an unset secret instead of treating a misconfiguration as an answer', async () => {
      global.fetch = delivery(200, { count: 0 }) as never;
      await expect(fetchUserDeviceCount('', TARGET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws when a 200 carries no count, rather than rounding it to zero', async () => {
      global.fetch = delivery(200, { devices: 3 }) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    });

    it('throws on the list body the OLD user route returned, which a misdirected call still gets', async () => {
      global.fetch = delivery(200, [{ deviceId: 'd1' }]) as never;
      await expect(fetchUserDeviceCount('s', TARGET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    });
  });

  describe('inviteToChannel', () => {
    it('refuses with USER_HAS_NO_DEVICE when the person has genuinely never installed Canari', async () => {
      const { service, memberRepo } = makeService();
      global.fetch = delivery(200, { count: 0 }) as never;

      const err = await service
        .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'USER_HAS_NO_DEVICE',
      });
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('refuses with a DIFFERENT code when it could not ask, and adds nobody', async () => {
      // The whole point: this is not the same refusal as the one above, and the old fail-open
      // version answered it by inviting the person and reporting success.
      const { service, memberRepo } = makeService();
      global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as never;

      const err = await service
        .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'KEY_DISTRIBUTION_UNAVAILABLE',
      });
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('refuses with USER_BLOCKED when a block stands between the two people', async () => {
      // A salon invitation is almost always issued from a community both people belong to, so this
      // is the case that decides whether blocking means anything for salons at all.
      const { service, memberRepo } = makeService([{ '?column?': 1 }]);
      global.fetch = delivery(200, { count: 1 }) as never;

      const err = await service
        .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'USER_BLOCKED' });
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('asks about the block in BOTH directions, so the blocker cannot invite either', async () => {
      const { service, blockQuery } = makeService([{ '?column?': 1 }]);
      global.fetch = delivery(200, { count: 1 }) as never;

      await service
        .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
        .catch(() => undefined);

      const sql = String(blockQuery.mock.calls[0][0]);
      expect(sql).toContain('"blockerId" = $1 AND "blockedId" = $2');
      expect(sql).toContain('"blockerId" = $2 AND "blockedId" = $1');
    });

    it('refuses the block BEFORE asking chat-delivery anything about devices', async () => {
      // Never learn by failing what a fact could have told you: a refused invitation must not have
      // cost a round trip to another service first.
      const { service } = makeService([{ '?column?': 1 }]);
      global.fetch = delivery(200, { count: 1 }) as never;

      await service
        .inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
        .catch(() => undefined);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('lets the invitation through when the person has a device', async () => {
      const { service, memberRepo } = makeService();
      global.fetch = delivery(200, { count: 1 }) as never;

      await expect(
        service.inviteToChannel(CHANNEL, { targetUserId: TARGET, actorUserId: ACTOR })
      ).resolves.toMatchObject({ success: true, userId: TARGET });
      expect(memberRepo.save).toHaveBeenCalled();
    });
  });
});
