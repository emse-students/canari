/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

/**
 * ONE REFILL, ASSERTED ON ALL THREE DOORS THAT NEED IT.
 *
 * The Redis routing set is a CACHE; the `device_group_memberships` rows are the truth. After a
 * restart or a flush the set is empty while the group is full of people, and a request routed off
 * it reports `no_peer_online` about a conversation nobody has left.
 *
 * Three election entry points read that set, and each carried its own copy of the reload - the same
 * eleven lines three times, differing only in whether they said anything. Two were silent, so a
 * production Redis losing every routing set repopulated itself twice with no line anywhere and once
 * with two. A cache miss that costs a database scan and rewrites shared routing state is not
 * nothing, and the reader of the third block's log had no way to know the other two had happened.
 *
 * What is pinned here is the fused behaviour: every door reloads from the rows, refills the set,
 * and SAYS SO under its own tag. A fourth site (`SEND`, around line 838) reconciles against LIVE
 * members rather than reloading an empty set - a repair, not a cache miss - and is deliberately not
 * part of this.
 */
describe('MessagingService - the routing set is reloaded from the rows, once, at every door', () => {
  let service: MessagingService;
  let warn: jest.SpyInstance;

  // The welcome door also claims a short-lived election lock and clears it, so the fixture carries
  // `del` and a `pipeline` that resolves to nothing - enough for the door to run to its end.
  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    sadd: jest.fn().mockResolvedValue(2),
    publish: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn(() => ({
      exists: jest.fn().mockReturnThis(),
      sismember: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      srem: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    })),
  };
  const deviceGroupRepo = { find: jest.fn().mockResolvedValue([]) };

  /** A repository that holds nothing - `find` answers `[]`, the way a real one does. */
  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const body = { groupId: 'g1', requesterUserId: 'reqU', requesterDeviceId: 'reqD' };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    const logger = (service as unknown as { logger: { warn: (m: string) => void } }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest
      .spyOn(logger as unknown as { log: (m: string) => void }, 'log')
      .mockImplementation(() => {});
  });

  /** An empty cache over two active rows - the state a restart leaves behind. */
  const cacheEmptyRowsPresent = () => {
    redis.smembers.mockResolvedValue([]);
    redis.exists.mockResolvedValue(1);
    deviceGroupRepo.find.mockResolvedValue([
      { userId: 'ua', deviceId: 'da', groupId: 'g1', status: 'active' },
      { userId: 'reqU', deviceId: 'reqD', groupId: 'g1', status: 'active' },
    ]);
  };

  const DOORS: { name: string; tag: string; call: () => Promise<{ status: string }> }[] = [
    {
      name: 'notifyHistoryRequest',
      tag: 'HISTORY_REQ',
      call: () => service.notifyHistoryRequest('reqU', body),
    },
    {
      name: 'notifyBaseRefreshRequest',
      tag: 'BASE_REFRESH',
      call: () => service.notifyBaseRefreshRequest('reqU', body),
    },
    {
      name: 'notifyWelcomeRequest',
      tag: 'WELCOME_REQ',
      call: () => service.notifyWelcomeRequest('reqU', body),
    },
  ];

  for (const door of DOORS) {
    describe(`the ${door.tag} door`, () => {
      it('reloads the members from the rows and refills the set', async () => {
        cacheEmptyRowsPresent();

        await door.call();

        expect(deviceGroupRepo.find).toHaveBeenCalledWith({
          where: { groupId: 'g1', status: 'active' },
        });
        expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'ua:da', 'reqU:reqD');
      });

      it('elects the peer it just reloaded rather than reporting no_peer_online', async () => {
        cacheEmptyRowsPresent();

        const res = await door.call();

        expect(res.status).toBe('forwarded');
      });

      it('ACCUSES when it repopulates - a lost routing set is never silent', async () => {
        cacheEmptyRowsPresent();

        await door.call();

        const lines = warn.mock.calls.map((c) => String(c[0]));
        const line = lines.find((l) => l.includes('MEMBERS_CACHE_RELOADED'));
        expect(line).toBeDefined();
        // Under its caller's own tag, so the log says WHICH door paid for the miss.
        expect(line).toContain(door.tag);
        expect(line).toContain('g1');
      });

      it('says nothing and asks the database nothing when the cache is warm', async () => {
        redis.smembers.mockResolvedValue(['ua:da']);
        redis.exists.mockResolvedValue(1);

        await door.call();

        expect(deviceGroupRepo.find).not.toHaveBeenCalled();
        expect(redis.sadd).not.toHaveBeenCalled();
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'MEMBERS_CACHE_RELOADED'
        );
      });

      it('does not refill from an empty table - there is nothing to say the cache is wrong', async () => {
        redis.smembers.mockResolvedValue([]);
        redis.exists.mockResolvedValue(1);
        deviceGroupRepo.find.mockResolvedValue([]);

        await door.call();

        expect(redis.sadd).not.toHaveBeenCalled();
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'MEMBERS_CACHE_RELOADED'
        );
      });
    });
  }
});
