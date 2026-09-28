/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/sender-mismatch` - a client saying a frame's envelope named another sender than the one
 * OpenMLS verified (channel-encryption section 21, WP-G2-1).
 *
 * The client refuses nothing yet and its console is collected nowhere, so this line IS the
 * measurement the refusal waits on. It is judged on two things: a reader can tell who reported what
 * on which path without asking the device, and no field of the body can forge a line of its own.
 */
describe('MessagingController - POST mls/sender-mismatch', () => {
  let controller: MessagingController;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    // Mocked rather than merely spied: the assertion is on the ARGUMENT, never on the output.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [{ provide: MessagingService, useValue: {} as unknown as MessagingService }],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  afterEach(() => warn.mockRestore());

  it('prints who reported it, the path, the kind, and both senders', () => {
    expect(
      controller.reportSenderMismatch('alice', 'web-alice-1', {
        groupId: 'g-1234',
        path: 'live',
        kind: 'user',
        envelopeUserId: 'mallory',
        envelopeDeviceId: 'dev-m',
        verifiedIdentity: 'bob:dev-b',
      })
    ).toEqual({ recorded: true });

    expect(warn).toHaveBeenCalledWith(
      '[SENDER_MISMATCH] reporter=alice:web-alice-1 group=g-1234 path=live kind=user ' +
        'envelope=mallory:dev-m verified=bob:dev-b'
    );
  });

  it('names an unreadable credential and an absent envelope device, rather than printing blanks', () => {
    controller.reportSenderMismatch('alice', 'web-alice-1', {
      groupId: 'g-1234',
      path: 'distribution',
      kind: 'unverifiable',
      envelopeUserId: 'bob',
      envelopeDeviceId: null,
      verifiedIdentity: null,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('envelope=bob:none'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('verified=unreadable'));
  });

  it('cannot be made to forge a log line: a value outside the allowlist prints as invalid', () => {
    controller.reportSenderMismatch('alice', 'web-alice-1', {
      groupId: 'g-1\n[SEND] forged',
      path: 'live',
      kind: 'user',
      envelopeUserId: { not: 'a string' },
      verifiedIdentity: 'bob:dev-b',
    });

    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('group=invalid');
    expect(line).toContain('envelope=invalid:none');
  });
});
