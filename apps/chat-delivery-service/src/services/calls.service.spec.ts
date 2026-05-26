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

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        {
          provide: getRepositoryToken(GroupMember),
          useValue: groupMemberRepo,
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
});
