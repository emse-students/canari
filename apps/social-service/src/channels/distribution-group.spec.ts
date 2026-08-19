import {
  ForbiddenException,
  Logger,
  NotFoundException,
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

/**
 * Social-service is the ONLY gate in front of a community's Graine key-distribution group: the
 * GroupInfo it hands out is the capability to enter that group and read every seed on it, and
 * community membership - the fact that authorizes it - lives in this service and nowhere else.
 *
 * So what these tests are really pinning down is that no path reaches chat-delivery without the
 * membership check having run first, and that a call this service cannot complete is reported as a
 * failure rather than as an empty answer. That rule used to hold HERE and nowhere else -
 * `userHasMlsDevices` failed open, and the day its URL was wrong it was a constant `true` - which
 * is why the mechanism was extracted to `internal/delivery.client.ts` on 2026-08-19 and both now
 * share it.
 */
describe('ChannelService - the community distribution group', () => {
  const SECRET = 'internal-secret-for-tests';
  const WORKSPACE = 'ws-1';
  const WORKSPACE_NAME = 'Les Canaris';
  const USER = 'u1';

  let fetchMock: jest.Mock;
  let previousSecret: string | undefined;

  /** A fetch answering 200 with `payload`, recording every call for the assertions below. */
  function answerWith(payload: unknown, ok = true): jest.Mock {
    return jest.fn(() =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as unknown as Response)
    );
  }

  /** `null` means "the deployment has no INTERNAL_SECRET"; `undefined` would hit the default. */
  function makeService(secret: string | null = SECRET) {
    if (secret === null) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = secret;

    const workspaceRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ id: WORKSPACE, ...x })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn((cb: (m: { delete: jest.Mock }) => Promise<void>) =>
          cb({ delete: jest.fn().mockResolvedValue({ affected: 1 }) })
        ),
      },
    };
    const channelRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ id: 'c-1', ...x })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const roleRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ id: 'r-1', ...x })),
    };
    const memberRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve(x)),
      delete: jest.fn(),
    };
    const messageRepo = { delete: jest.fn(), manager: { transaction: jest.fn() } };
    const inviteRepo = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn(() => Promise.resolve()) };

    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      messageRepo as unknown as Repository<ChannelMessage>,
      inviteRepo as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    return { service, workspaceRepo, channelRepo, roleRepo, memberRepo, redis };
  }

  beforeEach(() => {
    previousSecret = process.env.INTERNAL_SECRET;
    fetchMock = answerWith({ groupId: 'g-1', created: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    // Half these tests drive failure paths on purpose, and every one of them logs at ERROR by
    // design. Silenced at the prototype because the client's logger is module-level: an expected
    // error printed by a passing suite is exactly the line whose successor nobody reads.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  describe('a community is created with its distribution group', () => {
    it('stores the group id chat-delivery minted', async () => {
      const { service, workspaceRepo } = makeService();

      const created = await service.createWorkspace({
        name: 'Test',
        slug: 'test',
        createdBy: USER,
      });

      expect(created.distributionGroupId).toBe('g-1');
      // Saved twice: the row, then the row carrying its group id. The second save is what makes
      // the pointer durable - without it the community would look created and be unusable.
      expect(workspaceRepo.save).toHaveBeenCalledTimes(2);
    });

    it('unwinds the community when the group cannot be created', async () => {
      const { service, workspaceRepo, channelRepo } = makeService();
      global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as never;

      await expect(
        service.createWorkspace({ name: 'Test', slug: 'test', createdBy: USER })
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The row goes, so the slug is not held hostage by a community whose salons could never be
      // encrypted, and nothing downstream of it was created either.
      expect(workspaceRepo.delete).toHaveBeenCalledWith({ id: WORKSPACE });
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('unwinds it just the same when chat-delivery answers a non-2xx', async () => {
      const { service, workspaceRepo } = makeService();
      global.fetch = answerWith({}, false) as unknown as typeof fetch;

      await expect(
        service.createWorkspace({ name: 'Test', slug: 'test', createdBy: USER })
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(workspaceRepo.delete).toHaveBeenCalledWith({ id: WORKSPACE });
    });

    it('refuses to proceed at all when INTERNAL_SECRET is unset', async () => {
      const { service, workspaceRepo } = makeService(null);

      await expect(
        service.createWorkspace({ name: 'Test', slug: 'test', createdBy: USER })
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // Fails CLOSED: a misconfigured deployment must be visible, not quietly produce communities
      // with no key distribution at all.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(workspaceRepo.delete).toHaveBeenCalledWith({ id: WORKSPACE });
    });
  });

  describe('serving the group to a member', () => {
    it('refuses a user who is not in the community, without asking chat-delivery', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.getDistributionGroupForMember(WORKSPACE, USER)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      // The check is the point: reaching chat-delivery first would mean the capability had already
      // been fetched for someone with no right to it.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses on an archived community', async () => {
      const { service, workspaceRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue(null);

      await expect(service.getDistributionGroupForMember(WORKSPACE, USER)).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes an uninitialised group through as a state, not an error', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      global.fetch = answerWith({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: null,
      }) as unknown as typeof fetch;

      // The caller has to act on this: it is the first member in, and the one that will create the
      // MLS group and publish back. An exception here would leave nobody able to start.
      expect(await service.getDistributionGroupForMember(WORKSPACE, USER)).toEqual({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: null,
      });
    });

    it('returns the published GroupInfo to a member', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      global.fetch = answerWith({
        groupId: 'g-1',
        groupInfo: 'Z2k=',
        baseEpoch: 3,
      }) as unknown as typeof fetch;

      expect(await service.getDistributionGroupForMember(WORKSPACE, USER)).toEqual({
        groupId: 'g-1',
        groupInfo: 'Z2k=',
        baseEpoch: 3,
      });
    });

    it('says loudly that a community has no distribution group at all', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      global.fetch = answerWith(null) as unknown as typeof fetch;

      // Carried as a code, never a sentence: the client has to tell this apart from "not a member"
      // and from "delivery is down", and a distinction carried in prose is one no call site makes.
      await expect(service.getDistributionGroupForMember(WORKSPACE, USER)).rejects.toMatchObject({
        response: { code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP' },
      });
    });

    it('reports an unreachable chat-delivery as unavailable, not as an empty community', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      global.fetch = jest.fn(() => Promise.reject(new Error('timeout'))) as unknown as never;

      await expect(service.getDistributionGroupForMember(WORKSPACE, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    });
  });

  describe('publishing group info', () => {
    it('refuses a user who is not in the community', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue(null);

      await expect(
        service.publishDistributionGroupInfoForMember(WORKSPACE, USER, 'Z2k=', 2)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards a member GroupInfo and reports what the far side stored', async () => {
      const { service, workspaceRepo, memberRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, archived: false });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      const fetchSpy = answerWith({ stored: false });
      global.fetch = fetchSpy as unknown as typeof fetch;

      // `stored: false` is the monotonic rule refusing to regress the base epoch - a legitimate
      // outcome the caller must see rather than a failure.
      expect(
        await service.publishDistributionGroupInfoForMember(WORKSPACE, USER, 'Z2k=', 2)
      ).toEqual({ stored: false });
      expect(String(fetchSpy.mock.calls[0][0])).toContain(
        `/api/internal/mls/distribution-groups/workspace/${WORKSPACE}/group-info`
      );
    });
  });

  describe('a community taking its distribution group with it', () => {
    /** An admin of WORKSPACE, so `deleteWorkspace` gets past its permission check. */
    function asAdmin(repos: {
      workspaceRepo: { findOne: jest.Mock };
      roleRepo: { find: jest.Mock };
      memberRepo: { findOne: jest.Mock };
    }) {
      repos.workspaceRepo.findOne.mockResolvedValue({
        id: WORKSPACE,
        name: WORKSPACE_NAME,
        slug: 'test',
        archived: false,
      });
      repos.memberRepo.findOne.mockResolvedValue({
        workspaceId: WORKSPACE,
        userId: USER,
        roleIds: ['r-1'],
      });
      repos.roleRepo.find.mockResolvedValue([
        { id: 'r-1', permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE] },
      ]);
    }

    it('deletes the group before deleting anything', async () => {
      const repos = makeService();
      asAdmin(repos);
      const deleteFetch = answerWith({ deleted: true });
      global.fetch = deleteFetch as unknown as typeof fetch;

      await repos.service.deleteWorkspace(WORKSPACE, USER, WORKSPACE_NAME);

      expect(deleteFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
      expect(repos.workspaceRepo.manager.transaction).toHaveBeenCalled();
    });

    it('leaves the community intact when the group cannot be deleted', async () => {
      const repos = makeService();
      asAdmin(repos);
      global.fetch = jest.fn(() => Promise.reject(new Error('down'))) as unknown as never;

      await expect(
        repos.service.deleteWorkspace(WORKSPACE, USER, WORKSPACE_NAME)
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // A half-deletion is the state nothing can reconcile afterwards: the community would be gone
      // while its group lived on, named by nobody. Retryable beats orphaned.
      expect(repos.workspaceRepo.manager.transaction).not.toHaveBeenCalled();
      expect(repos.workspaceRepo.save).not.toHaveBeenCalled();
    });

    /**
     * The deletion is irreversible now, so the typed name is a gate and not a formality. It is
     * checked on the server because the fleet still holds clients built when this call archived:
     * they send no name at all, and must be refused rather than obeyed.
     */
    it('refuses a name that does not match, and touches nothing', async () => {
      const repos = makeService();
      asAdmin(repos);
      const deleteFetch = answerWith({ deleted: true });
      global.fetch = deleteFetch as unknown as typeof fetch;

      for (const wrong of ['', 'les canaris', 'Les Canari', 'Les  Canaris']) {
        await expect(repos.service.deleteWorkspace(WORKSPACE, USER, wrong)).rejects.toMatchObject({
          response: { code: 'WORKSPACE_CONFIRMATION_MISMATCH' },
        });
      }

      // Refused BEFORE the distribution group call: that one is not undoable either.
      expect(deleteFetch).not.toHaveBeenCalled();
      expect(repos.workspaceRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('accepts the name with surrounding whitespace, which a copy carries', async () => {
      const repos = makeService();
      asAdmin(repos);
      global.fetch = answerWith({ deleted: true }) as unknown as typeof fetch;

      await repos.service.deleteWorkspace(WORKSPACE, USER, `  ${WORKSPACE_NAME}\n`);

      expect(repos.workspaceRepo.manager.transaction).toHaveBeenCalled();
    });
  });

  describe('a departure cuts the leaver off the key distribution', () => {
    /** A workspace with `member` in it and one other member, so no last-member rule fires. */
    function communityWith(
      memberRepo: { findOne: jest.Mock; find: jest.Mock },
      workspaceRepo: { findOne: jest.Mock }
    ) {
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, name: WORKSPACE_NAME });
      memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER, roleIds: [] });
      memberRepo.find.mockResolvedValue([
        { workspaceId: WORKSPACE, userId: USER, roleIds: [] },
        { workspaceId: WORKSPACE, userId: 'u2', roleIds: [] },
      ]);
    }

    it('evicts the leaver from the distribution group BEFORE dropping their membership row', async () => {
      const { service, memberRepo, workspaceRepo } = makeService();
      communityWith(memberRepo, workspaceRepo);
      global.fetch = answerWith({ evicted: true, memberships: 2, queued: 5, routes: 2 }) as never;

      await expect(service.leaveWorkspace(WORKSPACE, USER)).resolves.toEqual({ success: true });

      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(String(url)).toContain(
        `internal/mls/distribution-groups/workspace/${WORKSPACE}/members/${USER}`
      );
      expect(init.method).toBe('DELETE');
      expect(memberRepo.delete).toHaveBeenCalledWith({ workspaceId: WORKSPACE, userId: USER });
    });

    it('names each of the three stores it cut, rather than one of them twice', async () => {
      // The line used to print `routes=` and pass `memberships`. On a one-device leaver the two
      // agree, so it read as correct for as long as it could not be wrong - which is why the
      // counts here are deliberately all different. Three stores are cut and none stands in for
      // the others.
      const { service, memberRepo, workspaceRepo } = makeService();
      communityWith(memberRepo, workspaceRepo);
      global.fetch = answerWith({ evicted: true, memberships: 3, queued: 5, routes: 2 }) as never;

      await service.leaveWorkspace(WORKSPACE, USER);

      const line = (service['logger'].log as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('key distribution cut'));
      expect(line).toContain('memberships=3');
      expect(line).toContain('routes=2');
      expect(line).toContain('queued=5');
    });

    it('says a community has no distribution group instead of reporting three zeros', async () => {
      // `evicted: false` is the only thing separating "there was nothing to cut off" from "it was
      // cut off clean", and both answer with zeros. The flag is known on the delivery side and the
      // decision is made here, so it travels rather than being inferred.
      const { service, memberRepo, workspaceRepo } = makeService();
      communityWith(memberRepo, workspaceRepo);
      global.fetch = answerWith({ evicted: false, memberships: 0, queued: 0, routes: 0 }) as never;

      await expect(service.leaveWorkspace(WORKSPACE, USER)).resolves.toEqual({ success: true });

      expect(
        (service['logger'].warn as jest.Mock).mock.calls.map((c) => String(c[0]))
      ).toContainEqual(expect.stringContaining('no distribution group to cut'));
      expect(
        (service['logger'].log as jest.Mock).mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes('key distribution cut'))
      ).toEqual([]);
    });

    it('does not remove the member when the eviction could not be completed', async () => {
      // The two halves of a departure are not symmetric: the MLS commit lands whenever a remaining
      // member next loads the community, but nothing ever comes back for a routing row left behind.
      // Failing here leaves them a member and the whole departure retryable.
      const { service, memberRepo, workspaceRepo, redis } = makeService();
      communityWith(memberRepo, workspaceRepo);
      global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as never;

      await expect(service.leaveWorkspace(WORKSPACE, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );

      expect(memberRepo.delete).not.toHaveBeenCalled();
      expect(redis.publishChannelEvent).not.toHaveBeenCalled();
    });

    it('cuts a kicked member off through the very same seam', async () => {
      const { service, memberRepo, workspaceRepo, roleRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, name: WORKSPACE_NAME });
      memberRepo.findOne
        .mockResolvedValueOnce({ workspaceId: WORKSPACE, userId: USER, roleIds: ['r-admin'] })
        .mockResolvedValueOnce({ workspaceId: WORKSPACE, userId: 'u2', roleIds: [] });
      memberRepo.find.mockResolvedValue([
        { workspaceId: WORKSPACE, userId: USER, roleIds: ['r-admin'] },
        { workspaceId: WORKSPACE, userId: 'u2', roleIds: [] },
      ]);
      roleRepo.find.mockResolvedValue([
        { id: 'r-admin', permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE], priority: 10 },
      ]);
      global.fetch = answerWith({ evicted: true, memberships: 1, queued: 0, routes: 1 }) as never;

      await expect(service.kickFromWorkspace(WORKSPACE, 'u2', USER)).resolves.toEqual({
        success: true,
      });

      const [url] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(String(url)).toContain(
        `internal/mls/distribution-groups/workspace/${WORKSPACE}/members/u2`
      );
      expect(memberRepo.delete).toHaveBeenCalledWith({ workspaceId: WORKSPACE, userId: 'u2' });
    });

    it('refuses the last admin before it cuts anything off', async () => {
      // Order matters: a removal that is going to be refused must not have already revoked the
      // key distribution of somebody who stays.
      const { service, memberRepo, workspaceRepo, roleRepo } = makeService();
      workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, name: WORKSPACE_NAME });
      memberRepo.findOne.mockResolvedValue({
        workspaceId: WORKSPACE,
        userId: USER,
        roleIds: ['r-admin'],
      });
      memberRepo.find.mockResolvedValue([
        { workspaceId: WORKSPACE, userId: USER, roleIds: ['r-admin'] },
        { workspaceId: WORKSPACE, userId: 'u2', roleIds: [] },
      ]);
      roleRepo.find.mockResolvedValue([
        { id: 'r-admin', permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE], priority: 10 },
      ]);

      await expect(service.leaveWorkspace(WORKSPACE, USER)).rejects.toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });
  });
  /**
   * A PRIVATE SALON HAS ITS OWN GROUP, and that is the whole point of the scope.
   *
   * Before this, section 4.3 gave a community exactly one distribution group, so every member held
   * every private salon's seeds and the only thing keeping them out was the server refusing to
   * serve the ciphertext. These tests pin the two halves that make the guarantee cryptographic
   * instead: the seeds go to a group whose roster is the salon's, and no path reaches that group's
   * GroupInfo without `canAccessChannel` having said yes first.
   */
  describe('a private salon and its own distribution group', () => {
    const CHANNEL = 'c-secret';

    /** A private salon `allowedUsers` names, in a community `USER` belongs to. */
    function arrangePrivateSalon(
      repos: ReturnType<typeof makeService>,
      overrides: Record<string, unknown> = {}
    ) {
      const channel = {
        id: CHANNEL,
        workspaceId: WORKSPACE,
        name: 'direction',
        isPrivate: true,
        archived: false,
        allowedUsers: [USER],
        distributionGroupId: 'g-chan',
        writePolicy: 'everyone',
        ...overrides,
      };
      repos.channelRepo.findOne.mockResolvedValue(channel);
      repos.memberRepo.findOne.mockResolvedValue({
        workspaceId: WORKSPACE,
        userId: USER,
        roleIds: [],
      });
      return channel;
    }

    /** An actor holding exactly `permissions` in the community. */
    function arrangeActorRole(repos: ReturnType<typeof makeService>, permissions: string[]) {
      repos.memberRepo.findOne.mockResolvedValue({
        workspaceId: WORKSPACE,
        userId: USER,
        roleIds: ['r-admin'],
      });
      repos.roleRepo.find.mockResolvedValue([{ id: 'r-admin', permissions, priority: 10 }]);
    }

    it('mints the salon its own group, under the CHANNEL scope', async () => {
      const repos = makeService();
      repos.workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, name: WORKSPACE_NAME });
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_CHANNEL]);

      await repos.service.createChannel({
        workspaceId: WORKSPACE,
        name: 'direction',
        actorUserId: USER,
        visibility: 'private',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('internal/mls/distribution-groups');
      // The scope IS the roster. Creating it under the community's scope would be the same group
      // under another name - the exact sharing this column exists to end.
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        scope: 'channel',
        scopeId: 'c-1',
      });
    });

    it('unwinds the salon when its group cannot be minted', async () => {
      const repos = makeService();
      repos.workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE, name: WORKSPACE_NAME });
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_CHANNEL]);
      global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as never;

      await expect(
        repos.service.createChannel({
          workspaceId: WORKSPACE,
          name: 'direction',
          actorUserId: USER,
          visibility: 'private',
        })
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // A salon marked private with no group of its own is a salon whose seeds have nowhere to go,
      // and the row would sit there looking usable.
      expect(repos.channelRepo.delete).toHaveBeenCalledWith({ id: 'c-1' });
    });

    it('serves the GroupInfo to someone the roster names', async () => {
      const repos = makeService();
      arrangePrivateSalon(repos);
      global.fetch = answerWith({
        groupId: 'g-chan',
        groupInfo: 'Z2k=',
        baseEpoch: 3,
      }) as unknown as typeof fetch;

      await expect(
        repos.service.getChannelDistributionGroupForMember(CHANNEL, USER)
      ).resolves.toEqual({ groupId: 'g-chan', groupInfo: 'Z2k=', baseEpoch: 3 });
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
        'distribution-groups/channel/' + CHANNEL
      );
    });

    it('refuses an ADMIN who has not joined - which is what makes the roster finite', async () => {
      const repos = makeService();
      arrangePrivateSalon(repos, { allowedUsers: ['someone-else'] });
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE]);

      // MANAGE_WORKSPACE used to be a silent bypass, which made the roster "allowedUsers plus
      // whoever holds an admin role right now" - a set that changes without anyone touching the
      // salon, and therefore a set no MLS group can be sealed to.
      await expect(
        repos.service.getChannelDistributionGroupForMember(CHANNEL, USER)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('serves that same admin once they have joined explicitly', async () => {
      const repos = makeService();
      const channel = arrangePrivateSalon(repos, { allowedUsers: [] });
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE]);

      await expect(repos.service.joinPrivateChannelAsAdmin(CHANNEL, USER)).resolves.toEqual({
        success: true,
        alreadyMember: false,
      });

      // In the member list, and nowhere else: no system message is written, on the user's decision
      // of 2026-08-19.
      expect(channel.allowedUsers).toEqual([USER]);
      expect(repos.redis.publishChannelEvent).toHaveBeenCalledWith(
        'channel.member.joined',
        expect.objectContaining({ channelId: CHANNEL, joinedBy: USER }),
        expect.any(Array)
      );
    });

    it('refuses to join a public salon as an admin, rather than granting nothing', async () => {
      const repos = makeService();
      arrangePrivateSalon(repos, { isPrivate: false, distributionGroupId: null });
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE]);

      await expect(repos.service.joinPrivateChannelAsAdmin(CHANNEL, USER)).rejects.toMatchObject({
        response: { code: 'CHANNEL_IS_PUBLIC' },
      });
    });

    it('refuses a PUBLIC salon its own group instead of answering with the community one', async () => {
      const repos = makeService();
      arrangePrivateSalon(repos, { isPrivate: false, distributionGroupId: null });

      // Answering with the community's group would let a client believe a per-salon roster exists
      // where none does - the confusion this scope was added to end.
      await expect(
        repos.service.getChannelDistributionGroupForMember(CHANNEL, USER)
      ).rejects.toMatchObject({ response: { code: 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP' } });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('cuts a community leaver off EVERY private salon, roster included', async () => {
      const repos = makeService();
      const salon = {
        id: CHANNEL,
        workspaceId: WORKSPACE,
        isPrivate: true,
        allowedUsers: [USER, 'u2'],
        distributionGroupId: 'g-chan',
      };
      repos.channelRepo.find.mockResolvedValue([salon]);
      repos.workspaceRepo.findOne.mockResolvedValue({ id: WORKSPACE });
      repos.memberRepo.findOne.mockResolvedValue({ workspaceId: WORKSPACE, userId: USER });
      repos.memberRepo.find.mockResolvedValue([
        { workspaceId: WORKSPACE, userId: USER, roleIds: ['r-admin'] },
        { workspaceId: WORKSPACE, userId: 'u2', roleIds: ['r-admin'] },
      ]);
      repos.roleRepo.find.mockResolvedValue([
        { id: 'r-admin', permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE], priority: 10 },
      ]);

      await repos.service.leaveWorkspace(WORKSPACE, USER);

      const evictions = (global.fetch as jest.Mock).mock.calls
        .map(([url]: [unknown]) => String(url))
        .filter((u: string) => u.includes('/members/'));
      expect(evictions.some((u: string) => u.includes('channel/' + CHANNEL + '/members/'))).toBe(
        true
      );
      // The roster goes too: `reconcileDistributionGroupRoster` diffs the MLS tree against exactly
      // this list, so a leaver still named here keeps a leaf authorised at every reconciliation.
      expect(salon.allowedUsers).toEqual(['u2']);
    });

    it('retires the salon group when the salon becomes public', async () => {
      const repos = makeService();
      const channel = arrangePrivateSalon(repos);
      arrangeActorRole(repos, [CHANNEL_PERMISSIONS.MANAGE_CHANNEL]);
      global.fetch = answerWith({ deleted: true }) as unknown as typeof fetch;

      await repos.service.updateChannelAccess(CHANNEL, USER, false, []);

      const deletes = (global.fetch as jest.Mock).mock.calls.filter(
        ([, init]: [unknown, RequestInit]) => init?.method === 'DELETE'
      );
      expect(deletes.length).toBe(1);
      expect(String(deletes[0][0])).toContain('distribution-groups/channel/' + CHANNEL);
      expect(channel.distributionGroupId).toBeNull();
    });
  });
});
