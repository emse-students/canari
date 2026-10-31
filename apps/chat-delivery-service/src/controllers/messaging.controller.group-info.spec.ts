/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `GET /mls/group-info/:groupId` answers "nothing stored" as JSON. A handler's bare `null` leaves
 * Nest as an EMPTY body with no content type, which a client must read as "not the API" (a captive
 * portal's empty 2xx looks the same) - so the absence of a base is spelt `{ groupInfo: null }`.
 */
describe('MessagingController - GET mls/group-info answers JSON even when nothing is stored', () => {
  let controller: MessagingController;
  const getGroupInfo = jest.fn();

  beforeEach(async () => {
    getGroupInfo.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        { provide: MessagingService, useValue: { getGroupInfo } as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  it('spells a missing base as { groupInfo: null }, never a bare null', async () => {
    getGroupInfo.mockResolvedValue(null);
    await expect(controller.getGroupInfo('alice', 'g1')).resolves.toEqual({ groupInfo: null });
  });

  it('passes a stored base through unchanged', async () => {
    const base = { groupInfo: 'AAAA', baseEpoch: 3, activeEpoch: 4 };
    getGroupInfo.mockResolvedValue(base);
    await expect(controller.getGroupInfo('alice', 'g1')).resolves.toBe(base);
  });
});
