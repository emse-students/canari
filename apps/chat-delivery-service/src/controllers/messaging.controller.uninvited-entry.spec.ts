/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MAX_REMEMBERED_UNINVITED_ENTRIES, MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/uninvited-entry` - a client saying a new person entered one of its conversations by
 * their own commit, with no member adding them.
 *
 * A client's console is collected nowhere, so this line IS the count. It is judged as
 * `mls/sender-mismatch` is: a reader can tell who reported which entry without asking the device, and
 * no field of the body can forge a line of its own. Two more things make it a count rather than a
 * stream: only a member of the group may report, and one entry is one line however many member
 * devices report it.
 */
describe('MessagingController - POST mls/uninvited-entry', () => {
  let controller: MessagingController;
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;
  const isGroupMember = jest.fn();

  beforeEach(async () => {
    // Mocked rather than merely spied: the assertion is on the ARGUMENT, never on the output.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    isGroupMember.mockReset().mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        { provide: MessagingService, useValue: { isGroupMember } as unknown as MessagingService },
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

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  it('prints its kind, who reported it, the group, the entrant, the epoch and the key', async () => {
    await expect(
      controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch: 7,
        keyFingerprint: '00ff11ee',
        kind: 'new-person',
      })
    ).resolves.toEqual({ recorded: true });

    expect(isGroupMember).toHaveBeenCalledWith('g-1234', 'alice');
    expect(warn).toHaveBeenCalledWith(
      '[UNINVITED_ENTRY] kind=new-person reporter=alice:web-alice-1 group=g-1234 entrant=mallory:dev1 epoch=7 key=00ff11ee'
    );
  });

  it('counts a member coming back and a 1:1 peer apart from a new person, from an allowlist', async () => {
    const report = (entrant: string, epoch: number, kind?: unknown) =>
      controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant,
        epoch,
        keyFingerprint: 'aa',
        ...(kind === undefined ? {} : { kind }),
      });
    await report('bob:dev2', 9, 'returning');
    await report('dave:dev4', 10, 'direct-peer');
    await report('carol:dev3', 11);
    await report('erin:dev5', 12, 'kind=new-person forged');

    expect(warn.mock.calls[0][0]).toContain('kind=returning');
    expect(warn.mock.calls[1][0]).toContain('kind=direct-peer');
    expect(warn.mock.calls[2][0]).toContain('kind=unstated');
    expect(warn.mock.calls[3][0]).toMatch(/^\[UNINVITED_ENTRY\] kind=invalid /);
  });

  it('refuses a reporter who is not a member of the group, and counts nothing', async () => {
    isGroupMember.mockResolvedValue(false);

    await expect(
      controller.reportUninvitedEntry('eve', 'web-eve', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch: 7,
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.reportUninvitedEntry('eve', 'web-eve', { entrant: 'mallory:dev1' })
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(warn).toHaveBeenCalledTimes(2);
    for (const [line] of warn.mock.calls) expect(line).toContain('REJECT not-a-member');
  });

  it('prints one line per entry, however many member devices report it', async () => {
    const entry = { groupId: 'g-1234', entrant: 'mallory:dev1', epoch: 7, keyFingerprint: '00' };
    await controller.reportUninvitedEntry('alice', 'web-alice-1', entry);
    await controller.reportUninvitedEntry('alice', 'phone-alice', entry);
    await controller.reportUninvitedEntry('bob', 'web-bob', entry);
    // The same device entering again later is another entry.
    await controller.reportUninvitedEntry('bob', 'web-bob', { ...entry, epoch: 12 });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('epoch=7');
    expect(warn.mock.calls[1][0]).toContain('epoch=12');
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[0][0]).toContain('already counted');
  });

  it('forgets the oldest entry past its bound rather than growing without one', async () => {
    for (let epoch = 0; epoch <= MAX_REMEMBERED_UNINVITED_ENTRIES; epoch++) {
      await controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch,
      });
    }
    warn.mockClear();
    // Epoch 0 was the oldest and has been forgotten; the newest is still remembered.
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1234',
      entrant: 'mallory:dev1',
      epoch: 0,
    });
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1234',
      entrant: 'mallory:dev1',
      epoch: MAX_REMEMBERED_UNINVITED_ENTRIES,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('epoch=0 ');
  });

  it('cannot be made to forge a log line: a value outside the allowlist prints as invalid', async () => {
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1',
      entrant: { not: 'a string' },
      epoch: 1.5,
      keyFingerprint: '00ff\n[SEND] forged',
    });

    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('entrant=invalid');
    expect(line).toContain('epoch=invalid');
    expect(line).toContain('key=invalid');
  });

  it('names an absent field rather than printing a blank', async () => {
    await controller.reportUninvitedEntry('alice', 'web-alice-1', { groupId: 'g-1234' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('entrant=unstated'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('epoch=unstated'));
  });
});
