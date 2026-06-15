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
    incrbyfloat: jest.fn((key: string, n: number) => {
      const cur = parseFloat(redisStore.get(key) ?? '0') || 0;
      const next = cur + Number(n);
      redisStore.set(key, String(next));
      return Promise.resolve(String(next));
    }),
    expire: jest.fn(() => Promise.resolve(1)),
  };

  /** Current month's TURN-usage Redis key (matches the service's bucket). */
  const turnUsageKey = `turn:usage:${new Date().toISOString().slice(0, 7)}`;

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore.clear();
    delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB;
    delete process.env.CALL_RELAY_KBPS_PER_DEVICE;

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

  it('refuses TURN credentials once the monthly budget is reached', async () => {
    groupMemberRepo.findOne.mockResolvedValue({
      groupId: 'group-1',
      userId: 'user-1',
    });
    process.env.CLOUDFLARE_CALLS_API_TOKEN = 'token';
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key';
    process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '10';
    // 10 GB budget = 10000 MB; seed just over it.
    redisStore.set(turnUsageKey, '10001');

    await expect(
      service.getIceServers('user-1', 'group-1', 'call-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('accumulates estimated TURN usage when a call ends', async () => {
    process.env.CALL_RELAY_KBPS_PER_DEVICE = '3000';
    // Seed an active presence that started 10 minutes ago.
    redisStore.set(
      'call:user_active:user-1',
      JSON.stringify({
        deviceId: 'device-a',
        updatedAt: Date.now() - 10 * 60 * 1000,
      }),
    );

    await service.reportCallPresence('user-1', 'device-a', { active: false });

    // 3000 kbps * 600 s / 8000 = 225 MB.
    const used = parseFloat(redisStore.get(turnUsageKey) ?? '0');
    expect(used).toBeGreaterThan(200);
    expect(used).toBeLessThan(250);
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
