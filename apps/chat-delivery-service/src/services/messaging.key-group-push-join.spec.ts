/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { externalCommitFrame, memberCommitFrame } from '../testing/mlsFrameFixture';

/**
 * A SHUT PHONE JOINS A KEY GROUP FROM A PUSH THROUGH THE APP'S OWN GATE (channel-encryption section
 * 25, decided by the user 2026-10-22). The base is served and the commit accepted only for a key
 * group, only on social-service's `entitled: true`, never when a Welcome is owed, and the commit
 * door takes an external commit and nothing else - everything past that is `validateCommit`'s.
 */
describe('MessagingService - key-group join from a push', () => {
  let service: MessagingService;
  let previousSecret: string | undefined;
  let fetchSpy: jest.SpyInstance;

  const groupRepo = { findOne: jest.fn() };
  const groupInfoRepo = { findOne: jest.fn() };
  const deviceGroupRepo = { findOne: jest.fn(), find: jest.fn() };
  const queuedMessageRepo = { find: jest.fn() };
  const redis = { mget: jest.fn() };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) });

  const social = (status: number, body: unknown) =>
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const keyGroup = (cols: Record<string, string | null>, activeEpoch = 7) =>
    groupRepo.findOne.mockResolvedValue({
      id: 'kg-1',
      distributionWorkspaceId: null,
      distributionChannelId: null,
      activeEpoch,
      ...cols,
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'sekret';
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    deviceGroupRepo.findOne.mockResolvedValue(null);
    queuedMessageRepo.find.mockResolvedValue([]);
    redis.mget.mockResolvedValue([null]);
    groupInfoRepo.findOne.mockResolvedValue({ groupId: 'kg-1', groupInfo: 'R0k=', baseEpoch: 7 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: groupInfoRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  describe('readKeyGroupBaseForPush', () => {
    it('serves the base and the scope once social-service entitles the user', async () => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      social(200, { entitled: true });

      await expect(service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1')).resolves.toEqual({
        scope: { kind: 'workspace', id: 'ws-1' },
        welcomeOwed: false,
        base: { groupInfo: 'R0k=', baseEpoch: 7, activeEpoch: 7 },
      });
      expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
        kind: 'workspace',
        scopeId: 'ws-1',
        userId: 'user-1',
      });
    });

    it('refuses a conversation, without asking anybody and without reading its base', async () => {
      keyGroup({});

      await expect(
        service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1')
      ).rejects.toMatchObject({ response: { error: 'not_a_key_group' } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(groupInfoRepo.findOne).not.toHaveBeenCalled();
    });

    it('refuses a user social-service does not entitle, and serves no base', async () => {
      keyGroup({ distributionChannelId: 'ch-1' });
      social(200, { entitled: false });

      const refusal = service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1');
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refusal).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'not_entitled' },
      });
      expect(groupInfoRepo.findOne).not.toHaveBeenCalled();
    });

    it('is a retryable 503 - never a base - when social-service cannot answer', async () => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1')
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(groupInfoRepo.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['a Welcome is queued', [{ groupId: 'kg-1' }], [null]],
      ['an add is in flight', [], ['holder']],
    ])('serves no base when %s for a pending seat', async (_n, queued, locks) => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      social(200, { entitled: true });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending' });
      queuedMessageRepo.find.mockResolvedValue(queued);
      redis.mget.mockResolvedValue(locks);

      await expect(service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1')).resolves.toEqual({
        scope: { kind: 'workspace', id: 'ws-1' },
        welcomeOwed: true,
        base: null,
      });
      expect(groupInfoRepo.findOne).not.toHaveBeenCalled();
    });

    it('serves the base to a pending seat nothing follows (an unhonoured seat)', async () => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      social(200, { entitled: true });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending' });

      await expect(
        service.readKeyGroupBaseForPush('kg-1', 'user-1', 'dev-1')
      ).resolves.toMatchObject({ welcomeOwed: false, base: { baseEpoch: 7 } });
    });
  });

  describe('submitKeyGroupJoinForPush', () => {
    const body = (proto: string) => ({
      groupId: 'kg-1',
      deviceId: 'dev-1',
      senderId: 'user-1',
      baseEpoch: 7,
      proto,
      groupInfo: 'TkVYVA==',
      // Never forwarded: a push join admits, removes and excludes nobody.
      admits: [{ userId: 'user-9', deviceId: 'dev-9' }],
      excludeDeviceIds: ['user-9:dev-9'],
    });

    it('hands an external commit into a key group to validateCommit, narrowed', async () => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      const validate = jest
        .spyOn(service, 'validateCommit')
        .mockResolvedValue({ accepted: true, newEpoch: 8 });
      const proto = externalCommitFrame('kg-1', 7n);

      await expect(service.submitKeyGroupJoinForPush(body(proto), 'user-1')).resolves.toEqual({
        accepted: true,
        newEpoch: 8,
      });
      expect(validate).toHaveBeenCalledWith(
        {
          groupId: 'kg-1',
          deviceId: 'dev-1',
          senderId: 'user-1',
          baseEpoch: 7,
          proto,
          groupInfo: 'TkVYVA==',
        },
        'user-1'
      );
    });

    it('refuses a member commit, whatever group it names', async () => {
      keyGroup({ distributionWorkspaceId: 'ws-1' });
      const validate = jest.spyOn(service, 'validateCommit');

      await expect(
        service.submitKeyGroupJoinForPush(body(memberCommitFrame('kg-1', 7n)), 'user-1')
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(validate).not.toHaveBeenCalled();
    });

    it('refuses an external commit into a conversation', async () => {
      keyGroup({});
      const validate = jest.spyOn(service, 'validateCommit');

      await expect(
        service.submitKeyGroupJoinForPush(body(externalCommitFrame('kg-1', 7n)), 'user-1')
      ).rejects.toMatchObject({ response: { error: 'not_a_key_group' } });
      expect(validate).not.toHaveBeenCalled();
    });
  });
});
