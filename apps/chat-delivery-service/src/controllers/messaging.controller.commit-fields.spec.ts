/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/commit` hands the gate the fields the web client sends (`submitCommit`) and nothing
 * else. `ValidateCommitBody.welcome` is the background re-add's alone: a Welcome stored through the
 * foreground route would be a door nobody declared.
 */
describe('MessagingController - POST mls/commit passes a client commit only', () => {
  let controller: MessagingController;
  const validateCommit = jest.fn().mockResolvedValue({ accepted: true, newEpoch: 6 });

  const clientCommit = {
    groupId: 'g1',
    deviceId: 'web-a',
    baseEpoch: 5,
    proto: 'Y29tbWl0',
    senderId: 'alice',
    excludeDeviceIds: ['alice:web-a'],
    groupInfo: 'Z2k=',
    admits: [{ userId: 'bob', deviceId: 'web-b' }],
    removes: [{ userId: 'carol' }],
  };

  beforeEach(async () => {
    validateCommit.mockClear();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        {
          provide: MessagingService,
          useValue: { validateCommit } as unknown as MessagingService,
        },
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

  it('passes every field the web client sends, unchanged', async () => {
    await controller.validateCommit(clientCommit, 'alice');

    expect(validateCommit).toHaveBeenCalledWith(clientCommit, 'alice');
  });

  it('never hands the gate a Welcome, so a foreground commit stores none', async () => {
    const withWelcome = {
      ...clientCommit,
      welcome: { userId: 'bob', deviceId: 'web-b', payload: 'd2VsY29tZQ==' },
      somethingElse: true,
    };

    await controller.validateCommit(withWelcome, 'alice');

    expect(validateCommit).toHaveBeenCalledWith(clientCommit, 'alice');
    expect(validateCommit.mock.calls[0][0]).not.toHaveProperty('welcome');
  });
});
