/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/integrity-finding` - a client saying it saw one of two things it must never see: a
 * conversation split in two at one epoch (`fork`), or restored history carrying a forged author
 * signature (`forged-history`). Protocol: history-reconciliation, "Restored history carries its
 * author's signature", and mls-protocol, "Fork detection".
 *
 * A client's console is collected nowhere, so this ERROR line is the only place the event is read.
 * Judged on the same two things as `sender-mismatch`: who reported what, and no forged line.
 */
describe('MessagingController - POST mls/integrity-finding', () => {
  let controller: MessagingController;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
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

  afterEach(() => error.mockRestore());

  it('prints a fork with its epoch and the member whose claim differs', () => {
    expect(
      controller.reportIntegrityFinding('alice', 'web-alice-1', {
        kind: 'fork',
        groupId: 'g-1234',
        epoch: 7,
        peer: 'bob:dev-b',
        detail: 'fork',
      })
    ).toEqual({ recorded: true });

    expect(error).toHaveBeenCalledWith(
      '[INTEGRITY] kind=fork reporter=alice:web-alice-1 group=g-1234 epoch=7 peer=bob:dev-b detail=fork'
    );
  });

  it('prints forged history with the relayer and the author it claimed', () => {
    controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'forged-history',
      groupId: 'g-1234',
      peer: 'mallory',
      detail: 'signature',
    });
    expect(error).toHaveBeenCalledWith(
      '[INTEGRITY] kind=forged-history reporter=alice:web-alice-1 group=g-1234 epoch=none peer=mallory detail=signature'
    );
  });

  it('refuses a kind it does not know, and cannot be made to forge a line', () => {
    controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'something\n[SEND] forged',
      groupId: 'g-1\n[SEND] forged',
      epoch: 'seven',
      peer: { not: 'a string' },
    });
    const line = error.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('kind=invalid');
    expect(line).toContain('group=invalid');
    expect(line).toContain('epoch=invalid');
    expect(line).toContain('peer=invalid');
  });
});
