/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'crypto';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/push/membership-active` - THE DOOR THAT ANSWERED `active` WHATEVER THE SERVER DECIDED.
 *
 * A device that joined a group from a background FCM Welcome cannot call the JWT-guarded
 * `invitations/status`, so this exists to say the same thing under a PushSecret. It is the only
 * caller reached from outside a WebView: the Android `CanariFirebaseMessagingService` and the iOS
 * `canari_push.mm` both POST here, and both do exactly one thing with the reply - log its HTTP code.
 *
 * That is what made its two faults invisible.
 *
 * **IT REPORTED A SUCCESS THE WRITER HAD REFUSED.** `activateDeviceMembership` returns an outcome -
 * a revoked device, or one holding no key package, is refused (WP-GHOST-1) - and this door dropped
 * it and returned `{ status: 'active' }` regardless. A device the server had just decided never to
 * route to was told it was a member, and the only reader anywhere saw `HTTP 200`. Its sibling door
 * has thrown on the same refusal since the writers were fused; this is the same statement to the
 * same kind of caller, so it makes it the same way.
 *
 * **IT SANITIZED SHAPE, NOT IDENTITY.** `sanitizeQueryValue` accepts `unknown` and `pending` - the
 * client's own literals for "my identity has not resolved yet" - and this door CREATES an `active`
 * membership from nothing, which is the exact shape of the 2026-08-27 defect where a placeholder
 * was stored as a member of a real conversation one second before its two real members joined. The
 * one writer now refuses those values itself, so this door is belt and braces; it keeps its own
 * check because a 400 naming the field beats an outcome the caller has to read.
 */
describe('PushController - POST mls/push/membership-active', () => {
  let controller: PushController;
  let warn: jest.SpyInstance;

  const SECRET = 'push-secret-value';
  const USER = 'user-1';
  const DEVICE = 'tauri-abc-1';
  const GROUP = 'group-1';
  const HEADER = `PushSecret ${SECRET}`;

  const pushTokenRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    upsert: jest.fn(),
  };
  const messaging = { activateDeviceMembership: jest.fn() };

  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: crypto.createHash('sha256').update(SECRET).digest('hex'),
    });
    messaging.activateDeviceMembership.mockResolvedValue({ ok: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messaging as unknown as MessagingService },
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

  it('promotes through the one writer, under a tag that names this door', async () => {
    const got = await controller.markMembershipActivePush(HEADER, {
      userId: USER,
      deviceId: DEVICE,
      groupId: GROUP,
    });

    expect(got).toEqual({ status: 'active' });
    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(USER, DEVICE, GROUP, {
      tag: 'MEMBERSHIP_ACTIVE_PUSH',
    });
  });

  // The fault this file exists for. Both refusals the writer can return, because the door must not
  // be right about one of them by accident.
  it.each(['revoked', 'no_key_package'] as const)(
    'refuses rather than reporting `active` when the writer said %s',
    async (reason) => {
      messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason });

      await expect(
        controller.markMembershipActivePush(HEADER, {
          userId: USER,
          deviceId: DEVICE,
          groupId: GROUP,
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  );

  it('names the reason in the refusal, since the caller logs only what it is given', async () => {
    messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(
      controller.markMembershipActivePush(HEADER, {
        userId: USER,
        deviceId: DEVICE,
        groupId: GROUP,
      })
    ).rejects.toThrow(/revoked/);
  });

  it.each([
    ['userId', { userId: 'unknown', deviceId: DEVICE }],
    ['deviceId', { userId: USER, deviceId: 'pending' }],
  ])("refuses the client's unresolved-identity placeholder in %s", async (_field, ids) => {
    await expect(
      controller.markMembershipActivePush(HEADER, { ...ids, groupId: GROUP })
    ).rejects.toBeInstanceOf(BadRequestException);

    // Refused at the door, so nothing downstream is asked about a value that names no device.
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });

  it('still checks the PushSecret before any of this', async () => {
    pushTokenRepo.findOne.mockResolvedValue(null);

    await expect(
      controller.markMembershipActivePush(HEADER, {
        userId: USER,
        deviceId: DEVICE,
        groupId: GROUP,
      })
    ).rejects.toThrow('Invalid push secret');
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });
});
