/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/uninvited-entry` - a client saying a new person entered one of its conversations by
 * their own commit, with no member adding them.
 *
 * A client's console is collected nowhere, so this line IS the count. It is judged as
 * `mls/sender-mismatch` is: a reader can tell who reported which entry without asking the device, and
 * no field of the body can forge a line of its own.
 */
describe('MessagingController - POST mls/uninvited-entry', () => {
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

  it('prints who reported it, the group, the entrant, the epoch and the key', () => {
    expect(
      controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch: 7,
        keyFingerprint: '00ff11ee',
      })
    ).toEqual({ recorded: true });

    expect(warn).toHaveBeenCalledWith(
      '[UNINVITED_ENTRY] reporter=alice:web-alice-1 group=g-1234 entrant=mallory:dev1 epoch=7 key=00ff11ee'
    );
  });

  it('cannot be made to forge a log line: a value outside the allowlist prints as invalid', () => {
    controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1\n[SEND] forged',
      entrant: { not: 'a string' },
      epoch: 1.5,
      keyFingerprint: '00ff',
    });

    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('group=invalid');
    expect(line).toContain('entrant=invalid');
    expect(line).toContain('epoch=invalid');
  });

  it('names an absent field rather than printing a blank', () => {
    controller.reportUninvitedEntry('alice', 'web-alice-1', { groupId: 'g-1234' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('entrant=unstated'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('epoch=unstated'));
  });
});
