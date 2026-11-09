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
 * NO BACKGROUND WAKE FOR AN ASK (2026-10-31, review of #2791).
 *
 * The `welcome_request_pending` wake exists so a member's shut Android phone answers a request by
 * itself (the background Welcome). A push never answers an invitation link's ask - the route and
 * the gate refuse it, `awaiting_admission` - so waking every member's phone for one only spends a
 * lock, a key package and a refusal per phone on every re-ask, to learn by failing what the seat
 * already says. The stored frames still reach each member's app when it opens.
 */
describe('MessagingService - notifyWelcomeRequest wakes no phone for an ask', () => {
  let service: MessagingService;
  let wake: jest.SpyInstance;
  let log: jest.SpyInstance;
  const noPeerLine = () =>
    log.mock.calls.map(([m]) => String(m)).find((m) => m.includes('NO_PEER_ONLINE')) ?? '';

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
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
  const groupMemberRepo = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const body = {
    groupId: '00000000-0000-4000-8000-00000000c0a5',
    requesterUserId: 'reqU',
    requesterDeviceId: 'reqD',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Two routed devices, the requester's and a member's, and nobody online.
    redis.smembers.mockResolvedValue(['ua:da', 'reqU:reqD']);
    redis.exists.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        // The conversation exists: the welcome request relays any seat in it (`assertCallerHoldsSeat`).
        {
          provide: getRepositoryToken(Group),
          useValue: {
            ...emptyRepo(),
            findOne: jest.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-00000000c0a5' }),
          },
        },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
    log = jest.spyOn(logger, 'log').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    wake = jest
      .spyOn(
        service as unknown as { sendFcmWelcomeRequestPending: () => Promise<void> },
        'sendFcmWelcomeRequestPending'
      )
      .mockResolvedValue(undefined);
  });

  it("stores the ask for the members' apps and wakes no phone in the background", async () => {
    groupMemberRepo.findOne.mockResolvedValue({ id: 'seat-1', awaitingAdmission: true });

    const res = await service.notifyWelcomeRequest('reqU', body);

    expect(res.status).toBe('no_peer_online');
    expect(wake).not.toHaveBeenCalled();
    // The frame every member's app drains when it opens is still written.
    expect(redis.pipeline).toHaveBeenCalled();
    // The closing line says what happened, not what would have for a member's device.
    expect(noPeerLine()).toContain('no FCM wake');
    expect(noPeerLine()).not.toContain('FCM sent to peers');
  });

  it("still wakes the members' phones for a member's own device", async () => {
    groupMemberRepo.findOne.mockResolvedValue({ id: 'seat-1', awaitingAdmission: false });

    await service.notifyWelcomeRequest('reqU', body);

    expect(wake).toHaveBeenCalledWith(
      body.groupId,
      ['ua:da', 'reqU:reqD'],
      'reqU:reqD',
      expect.any(String)
    );
    expect(noPeerLine()).toContain('FCM sent to peers');
  });
});
