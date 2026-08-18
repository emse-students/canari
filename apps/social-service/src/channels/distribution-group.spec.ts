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
 * failure rather than as an empty answer. The service already carries one guard that fails OPEN
 * (`userHasMlsDevices`), and the day its URL was wrong that turned it into a constant `true`.
 */
describe('ChannelService - the community distribution group', () => {
  const SECRET = 'internal-secret-for-tests';
  const WORKSPACE = 'ws-1';
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
        `/api/internal/mls/distribution-groups/${WORKSPACE}/group-info`
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

    it('deletes the group before archiving anything', async () => {
      const repos = makeService();
      asAdmin(repos);
      const deleteFetch = answerWith({ deleted: true });
      global.fetch = deleteFetch as unknown as typeof fetch;

      await repos.service.deleteWorkspace(WORKSPACE, USER);

      expect(deleteFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
      expect(repos.channelRepo.update).toHaveBeenCalled();
    });

    it('leaves the community intact when the group cannot be deleted', async () => {
      const repos = makeService();
      asAdmin(repos);
      global.fetch = jest.fn(() => Promise.reject(new Error('down'))) as unknown as never;

      await expect(repos.service.deleteWorkspace(WORKSPACE, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
      // A half-deletion is the state nothing can reconcile afterwards: the community would be gone
      // while its group lived on, named by nobody. Retryable beats orphaned.
      expect(repos.channelRepo.update).not.toHaveBeenCalled();
      expect(repos.workspaceRepo.save).not.toHaveBeenCalled();
    });
  });
});
