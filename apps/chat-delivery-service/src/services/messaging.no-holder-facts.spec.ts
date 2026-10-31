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

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    mget: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn(() => ({
      sadd: jest.fn().mockReturnThis(),
      rpush: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    })),
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

  const body = { groupId: 'g1', requesterUserId: 'requ', requesterDeviceId: 'reqd' };

  beforeEach(async () => {
    jest.clearAllMocks();
    groupMemberRepo = repo();
    groupRepo = repo();
    groupInfoRepo = repo();
    deviceGroupRepo = repo();
    queuedMessageRepo = repo();
    // A member's device and the requester's, nobody online.
    redis.smembers.mockResolvedValue(['ua:da', 'requ:reqd']);
    redis.exists.mockResolvedValue(0);
    redis.mget.mockResolvedValue([null]);
    groupMemberRepo.findOne.mockResolvedValue({ id: 'seat-1', awaitingAdmission: false });
    groupRepo.findOne.mockResolvedValue({ id: 'g1', activeEpoch: 7 });
    deviceGroupRepo.find.mockResolvedValue([{ deviceId: 'reqd', status: 'pending' }]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: repo() },
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
    jest
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
      },
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
    });
  });

  it('carries no facts when a member device is online', async () => {
    redis.exists.mockResolvedValue(1);
    const res = await service.notifyWelcomeRequest('requ', body);
    expect(res.status).toBe('forwarded');
    expect(res.facts).toBeUndefined();
  });

  it("serves a conversation's base with the asking device's seat, read after it", async () => {
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
