/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/push/unavailable` - a device saying it cannot get a push token.
 *
 * WHAT THIS EXISTS TO PREVENT, and it is not a hypothetical. On 2026-08-27 `push_token` held 49
 * android rows and had never held ONE ios row: no message alert, no mention and no CallKit ring had
 * ever been deliverable to an iPhone, for the platform's entire life, and nothing anywhere had said
 * so. The absence of a row is indistinguishable from a device nobody opened, so the healthy
 * platform's 49 rows stood in for both.
 *
 * The endpoint is therefore judged on ONE thing: does the line it prints let a reader tell what
 * happened, on which platform, without asking the device. It deliberately writes no row - the
 * assertions below pin that too, because a table here would become a second source of truth for a
 * fact `push_token` already owns.
 */
describe('PushController - POST mls/push/unavailable', () => {
  let controller: PushController;
  let warn: jest.SpyInstance;

  const pushTokenRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    upsert: jest.fn(),
  };

  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Mocked rather than merely spied: a passing suite must not print warnings that read like
    // failures, and the assertion is on the ARGUMENT, never on the output.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('names the platform and the reason, so one GROUP BY answers which chain is broken', () => {
    const res = controller.reportPushUnavailable(
      { deviceId: 'tauri-abc-1', platform: 'ios', reason: 'no-token' },
      'user-1'
    );

    expect(res).toEqual({ recorded: true });
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('[PUSH_UNAVAILABLE]');
    expect(line).toContain('platform=ios');
    expect(line).toContain('reason=no-token');
    expect(line).toContain('device=tauri-abc-1');
  });

  it('prints a reason it does not recognise rather than replacing it with a guess', () => {
    // The client owns the classification. A server that normalises an unknown value to a known one
    // deletes the only evidence that the client learnt something the server has not been taught.
    controller.reportPushUnavailable(
      { deviceId: 'tauri-abc-1', platform: 'ios', reason: 'apns-entitlement-missing' },
      'user-1'
    );

    expect(warn.mock.calls[0][0]).toContain('reason=apns-entitlement-missing');
  });

  it('says `unstated` for a client that sends no reason, and never an empty field', () => {
    controller.reportPushUnavailable({ deviceId: 'tauri-abc-1' }, 'user-1');

    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('reason=unstated');
    // No platform stated means the FCM-native one, exactly as registration decides it - otherwise
    // the two lines could not be compared.
    expect(line).toContain('platform=android');
  });

  it('writes nothing - this is a report, and push_token already owns the state', () => {
    controller.reportPushUnavailable(
      { deviceId: 'tauri-abc-1', platform: 'ios', reason: 'no-token' },
      'user-1'
    );

    expect(pushTokenRepo.save).not.toHaveBeenCalled();
    expect(pushTokenRepo.update).not.toHaveBeenCalled();
    expect(pushTokenRepo.upsert).not.toHaveBeenCalled();
  });
});
