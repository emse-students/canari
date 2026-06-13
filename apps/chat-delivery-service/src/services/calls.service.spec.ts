/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CallsService } from './calls.service';
import { GroupMember } from '../entities/group-member.entity';

describe('CallsService', () => {
  let service: CallsService;
  const groupMemberRepo = {
    findOne: jest.fn(),
  };
  const redisStore = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      redisStore.delete(key);
      return Promise.resolve(1);
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore.clear();
    delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        {
          provide: getRepositoryToken(GroupMember),
          useValue: groupMemberRepo,
        },
        {
          provide: 'REDIS_CLIENT',
          useValue: redis,
        },
      ],
    }).compile();

    service = module.get(CallsService);
  });

  it('rejects non-members', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);
    await expect(
      service.getIceServers('user-1', 'group-1', 'call-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns 503 when Cloudflare TURN is not configured', async () => {
    groupMemberRepo.findOne.mockResolvedValue({
      groupId: 'group-1',
      userId: 'user-1',
    });
    await expect(
      service.getIceServers('user-1', 'group-1', 'call-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('stores and clears call presence per device', async () => {
    await service.reportCallPresence('user-1', 'device-a', {
      active: true,
      callId: 'call-1',
      groupId: 'group-1',
    });

    const sibling = await service.getSiblingCallStatus('user-1', 'device-b');
    expect(sibling).toEqual({
      active: true,
      deviceId: 'device-a',
      callId: 'call-1',
      groupId: 'group-1',
    });

    const sameDevice = await service.getSiblingCallStatus('user-1', 'device-a');
    expect(sameDevice).toEqual({ active: false });

    await service.reportCallPresence('user-1', 'device-a', { active: false });
    const afterClear = await service.getSiblingCallStatus('user-1', 'device-b');
    expect(afterClear).toEqual({ active: false });
  });
});
