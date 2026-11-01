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
 * THE NO-HOLDER FACTS TRAVEL IN THE SAME ANSWER AS THE VERDICT (D5 of
 * docs/wiki/protocols/mls-availability-no-holder.md).
 *
 * A requester shows "this conversation cannot be opened on this device" only on the whole set, read
 * in one answer: no member device online, the stored base absent or behind the group's epoch, and no
 * Welcome queued or Add in flight for it. So a `no_peer_online` answer carries the base's epochs and
 * the requester's seat, and the conversation's base is served with that seat too (D1: a further
 * device lets itself in only when no Add already carries it).
 */
describe('MessagingService - the facts a no-holder answer carries', () => {
  let service: MessagingService;

  const pipelineCalls: { op: string; args: unknown[] }[] = [];
  /** An in-memory Redis behind the pipeline: sets and lists, applied in call order at `exec`. */
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();
  const apply = (op: string, args: unknown[]) => {
    const key = String(args[0]);
    if (op === 'sadd') (sets.get(key) ?? sets.set(key, new Set()).get(key)!).add(String(args[1]));
    if (op === 'srem') sets.get(key)?.delete(String(args[1]));
    if (op === 'rpush') (lists.get(key) ?? lists.set(key, []).get(key)!).push(String(args[1]));
    if (op === 'lrem')
      lists.set(
        key,
        (lists.get(key) ?? []).filter((v) => v !== args[2])
      );
  };
  const pipe = () => {
    const p: Record<string, unknown> = {};
    const queued: { op: string; args: unknown[] }[] = [];
    for (const op of ['sadd', 'srem', 'rpush', 'lrem', 'expire']) {
      p[op] = jest.fn((...args: unknown[]) => {
        pipelineCalls.push({ op, args });
        queued.push({ op, args });
        return p;
      });
    }
    p.exec = jest.fn(async () => {
      for (const q of queued) apply(q.op, q.args);
      return [];
    });
    return p;
  };
  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    mget: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn(pipe),
  };
  const repo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });
  let groupMemberRepo: ReturnType<typeof repo>;
  let groupRepo: ReturnType<typeof repo>;
  let groupInfoRepo: ReturnType<typeof repo>;
  let deviceGroupRepo: ReturnType<typeof repo>;
  let queuedMessageRepo: ReturnType<typeof repo>;
  let keyPackageRepo: ReturnType<typeof repo>;
  let fcmWake: jest.SpyInstance;
  /** The group's device rows: the requester's pending seat, a member's live device by default. */
  let deviceRows: { userId: string; deviceId: string; status: string }[];
  /** The devices with a KeyPackage inside the retention window. */
  let liveKeyPackages: { userId: string; deviceId: string }[];
  const openTheDoor = () =>
    ((service as unknown as { furtherDeviceSelfJoinOpen: boolean }).furtherDeviceSelfJoinOpen =
      true);

  const body = { groupId: 'g1', requesterUserId: 'requ', requesterDeviceId: 'reqd' };

  beforeEach(async () => {
    jest.clearAllMocks();
    groupMemberRepo = repo();
    groupRepo = repo();
    groupInfoRepo = repo();
    deviceGroupRepo = repo();
    queuedMessageRepo = repo();
    keyPackageRepo = repo();
    pipelineCalls.length = 0;
    sets.clear();
    lists.clear();
    deviceRows = [
      { userId: 'requ', deviceId: 'reqd', status: 'pending' },
      { userId: 'ua', deviceId: 'da', status: 'active' },
    ];
    liveKeyPackages = [{ userId: 'ua', deviceId: 'da' }];
    // A member's device and the requester's, nobody online.
    redis.smembers.mockResolvedValue(['ua:da', 'requ:reqd']);
    redis.exists.mockResolvedValue(0);
    redis.mget.mockResolvedValue([null]);
    groupMemberRepo.findOne.mockResolvedValue({ id: 'seat-1', awaitingAdmission: false });
    groupRepo.findOne.mockResolvedValue({ id: 'g1', activeEpoch: 7 });
    deviceGroupRepo.find.mockImplementation(
      async ({ where }: { where: { userId?: string; status?: string } }) =>
        deviceRows.filter(
          (r) =>
            (where.userId === undefined || r.userId === where.userId) &&
            (where.status === undefined || r.status === where.status)
        )
    );
    keyPackageRepo.find.mockImplementation(async () => liveKeyPackages);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: repo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: repo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: repo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: groupInfoRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: repo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    fcmWake = jest
      .spyOn(
        service as unknown as { sendFcmWelcomeRequestPending: () => Promise<void> },
        'sendFcmWelcomeRequestPending'
      )
      .mockResolvedValue(undefined);
  });

  it('answers a welcome request nobody can take with the base epochs and the seat', async () => {
    groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 5 });

    const res = await service.notifyWelcomeRequest('requ', body);

    expect(res).toEqual({
      status: 'no_peer_online',
      facts: {
        base: { baseEpoch: 5, activeEpoch: 7 },
        seat: { status: 'pending', welcomeQueued: false, addInFlight: false },
        holders: { liveHolderDevices: 1, wakeSent: true },
      },
      selfJoin: false,
    });
  });

  it('says there is no base when none was ever published', async () => {
    const res = await service.notifyWelcomeRequest('requ', body);
    expect(res.facts?.base).toBeNull();
  });

  it('carries a queued Welcome and an Add in flight, so the requester keeps waiting', async () => {
    queuedMessageRepo.find.mockResolvedValue([{ groupId: 'g1' }]);
    redis.mget.mockResolvedValue(['held']);

    const res = await service.notifyWelcomeRequest('requ', body);

    expect(res.facts?.seat).toEqual({ status: 'pending', welcomeQueued: true, addInFlight: true });
  });

  it('answers an unread add lock as unknown, never as no Add', async () => {
    redis.mget.mockRejectedValue(new Error('redis down'));

    const res = await service.notifyWelcomeRequest('requ', body);

    expect(res.facts?.seat).toEqual({ status: 'pending', welcomeQueued: false });
  });

  it('tells a link ask nothing about the group (D4)', async () => {
    groupMemberRepo.findOne.mockResolvedValue({ id: 'seat-1', awaitingAdmission: true });
    const res = await service.notifyWelcomeRequest('requ', body);
    expect(res.facts).toBeUndefined();
  });

  it('tells a caller with no seat nothing about the group', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);
    const res = await service.notifyBaseRefreshRequest('requ', body);
    expect(res).toEqual({ status: 'no_peer_online' });
  });

  it('answers a base refresh nobody can take with the same facts', async () => {
    groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 6 });

    const res = await service.notifyBaseRefreshRequest('requ', body);

    expect(res.facts).toEqual({
      base: { baseEpoch: 6, activeEpoch: 7 },
      seat: { status: 'pending', welcomeQueued: false, addInFlight: false },
      holders: { liveHolderDevices: 1, wakeSent: false },
    });
  });

  describe('whether a member could still answer (D5 liveness)', () => {
    it('counts every active device with a KeyPackage inside the retention window but the asking one', async () => {
      deviceRows.push(
        { userId: 'requ', deviceId: 'old-phone', status: 'active' },
        { userId: 'ub', deviceId: 'db', status: 'active' },
        { userId: 'uc', deviceId: 'dc', status: 'removed' }
      );
      liveKeyPackages = [
        { userId: 'ua', deviceId: 'da' },
        { userId: 'requ', deviceId: 'old-phone' },
        { userId: 'requ', deviceId: 'reqd' },
      ];

      const res = await service.notifyBaseRefreshRequest('requ', body);

      expect(res.facts?.holders).toEqual({ liveHolderDevices: 2, wakeSent: false });
    });

    it("counts the user's OWN other device when it is the only live holder, so no banner shows", async () => {
      deviceRows = [
        { userId: 'requ', deviceId: 'reqd', status: 'pending' },
        { userId: 'requ', deviceId: 'old-phone', status: 'active' },
        { userId: 'ua', deviceId: 'da', status: 'active' },
      ];
      liveKeyPackages = [{ userId: 'requ', deviceId: 'old-phone' }];

      const res = await service.notifyBaseRefreshRequest('requ', body);

      expect(res.facts?.holders.liveHolderDevices).toBe(1);
    });

    it('reads zero when every other holder is gone past the window', async () => {
      liveKeyPackages = [];
      const res = await service.notifyBaseRefreshRequest('requ', body);
      expect(res.facts?.holders.liveHolderDevices).toBe(0);
    });
  });

  describe('the further-device door is gated on D2/D3 having reached every member client', () => {
    it('serves no seat while the door is shut, so the client reads seat_unreadable', async () => {
      groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 7 });
      jest
        .spyOn(
          service as unknown as { assertMayReadExternalBase: () => Promise<void> },
          'assertMayReadExternalBase'
        )
        .mockResolvedValue(undefined);

      const res = await service.getGroupInfo('g1', 'requ', 'reqd');

      expect(res).not.toHaveProperty('seat');
    });

    it('stores and wakes an ask carrying selfJoinIfNobody like any other while the door is shut', async () => {
      const res = await service.notifyWelcomeRequest('requ', { ...body, selfJoinIfNobody: true });

      expect(res.status).toBe('no_peer_online');
      // The answer says the door is shut, so the client waits for a member's Add without a second
      // join attempt (re-review of #2832, N2).
      expect(res.selfJoin).toBe(false);
      expect(fcmWake).toHaveBeenCalledTimes(1);
      expect(pipelineCalls.some((c) => c.op === 'sadd')).toBe(true);
    });
  });

  describe('one door per answer (D1): a further device that joins by itself', () => {
    beforeEach(() => {
      openTheDoor();
      groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 7 });
    });

    it('keeps the stored ask as the one door when the base is stale - the device cannot join on it', async () => {
      groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 5 });

      const res = await service.notifyWelcomeRequest('requ', { ...body, selfJoinIfNobody: true });

      expect(res.facts?.holders.wakeSent).toBe(true);
      expect(fcmWake).toHaveBeenCalledTimes(1);
      expect(pipelineCalls.some((c) => c.op === 'srem')).toBe(false);
    });

    it('stores, queues and wakes nothing, and withdraws an ask an earlier pass stored', async () => {
      const res = await service.notifyWelcomeRequest('requ', { ...body, selfJoinIfNobody: true });

      expect(res.status).toBe('no_peer_online');
      expect(res.selfJoin).toBe(true);
      expect(res.facts?.holders).toEqual({ liveHolderDevices: 1, wakeSent: false });
      expect(fcmWake).not.toHaveBeenCalled();
      expect(redis.sadd).not.toHaveBeenCalled();
      expect(pipelineCalls.filter((c) => c.op === 'sadd' || c.op === 'rpush')).toEqual([]);
      expect(pipelineCalls).toContainEqual({
        op: 'srem',
        args: ['pending_welcome:g1', 'requ:reqd'],
      });
      expect(pipelineCalls).toContainEqual({
        op: 'lrem',
        args: [
          'pending_welcome_notify:ua',
          0,
          JSON.stringify({
            type: 'welcome_request',
            groupId: 'g1',
            requesterUserId: 'requ',
            requesterDeviceId: 'reqd',
          }),
        ],
      });
    });

    it('withdraws exactly the bytes the store path pushed: an earlier stored ask leaves nothing behind', async () => {
      await service.notifyWelcomeRequest('requ', body);
      expect(sets.get('pending_welcome:g1')?.has('requ:reqd')).toBe(true);
      expect(lists.get('pending_welcome_notify:ua')).toHaveLength(1);

      await service.notifyWelcomeRequest('requ', { ...body, selfJoinIfNobody: true });

      expect(sets.get('pending_welcome:g1')?.has('requ:reqd')).toBe(false);
      expect(lists.get('pending_welcome_notify:ua')).toEqual([]);
    });

    it('still stores and wakes an ask without the intent', async () => {
      const res = await service.notifyWelcomeRequest('requ', body);
      expect(res.facts?.holders.wakeSent).toBe(true);
      expect(fcmWake).toHaveBeenCalledTimes(1);
    });

    it('forwards to an online member whatever the intent', async () => {
      redis.exists.mockResolvedValue(1);
      const res = await service.notifyWelcomeRequest('requ', { ...body, selfJoinIfNobody: true });
      expect(res.status).toBe('forwarded');
    });
  });

  it('carries no facts when a member device is online', async () => {
    redis.exists.mockResolvedValue(1);
    const res = await service.notifyWelcomeRequest('requ', body);
    expect(res.status).toBe('forwarded');
    expect(res.facts).toBeUndefined();
  });

  it("serves a conversation's base with the asking device's seat, read after it", async () => {
    openTheDoor();
    groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', groupInfo: 'AAA', baseEpoch: 7 });
    jest
      .spyOn(
        service as unknown as { assertMayReadExternalBase: () => Promise<void> },
        'assertMayReadExternalBase'
      )
      .mockResolvedValue(undefined);

    const withSeat = await service.getGroupInfo('g1', 'requ', 'reqd');
    const without = await service.getGroupInfo('g1', 'requ');

    expect(withSeat?.seat).toEqual({ status: 'pending', welcomeQueued: false, addInFlight: false });
    expect(without).not.toHaveProperty('seat');
    expect(groupInfoRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      deviceGroupRepo.find.mock.invocationCallOrder[0]
    );
  });
});
