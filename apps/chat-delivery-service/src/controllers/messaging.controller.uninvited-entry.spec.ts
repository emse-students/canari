/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';
import type { UninvitedEntryRow } from '../utils/uninvited-entries';

/**
 * `POST /mls/uninvited-entry` - a client saying a new person entered one of its conversations by
 * their own commit, with no member adding them.
 *
 * A client's console is collected nowhere, so this line IS the count. It is judged as
 * `mls/sender-mismatch` is: a reader can tell who reported which entry without asking the device, and
 * no field of the body can forge a line of its own. Two more things make it a count rather than a
 * stream: only a member of the group may report, and one entry is one line however many member
 * devices report it - decided by the `uninvited_entries` row the first report writes (migration
 * 053), so a deploy or a second replica does not count it again. The table's SQL is proven against a
 * real PostgreSQL by `053_uninvited_entries.integration.spec.ts`; here it is a set with the same
 * answer.
 */
describe('MessagingController - POST mls/uninvited-entry', () => {
  let controller: MessagingController;
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let error: jest.SpyInstance;
  const isGroupMember = jest.fn();
  /** The `uninvited_entries` table: its key, as the primary key spells it. */
  let table: Set<string>;
  const claimUninvitedEntry = jest.fn();

  /** A controller over the SAME table - what a second replica, or the process after a deploy, is. */
  const makeController = async (): Promise<MessagingController> => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        {
          provide: MessagingService,
          useValue: { isGroupMember, claimUninvitedEntry } as unknown as MessagingService,
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
    return module.get(MessagingController);
  };

  beforeEach(async () => {
    // Mocked rather than merely spied: the assertion is on the ARGUMENT, never on the output.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    isGroupMember.mockReset().mockResolvedValue(true);
    table = new Set();
    claimUninvitedEntry.mockReset().mockImplementation(async (row: UninvitedEntryRow) => {
      const key = `${row.groupId}|${row.entrant}|${row.epoch}|${row.kind}`;
      if (table.has(key)) return false;
      table.add(key);
      return true;
    });
    controller = await makeController();
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
    error.mockRestore();
  });

  it('prints its kind, who reported it, the group, the entrant, the epoch and the key', async () => {
    await expect(
      controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch: 7,
        keyFingerprint: '00ff11ee',
        kind: 'new-person',
        watchedFromEpoch: 4,
      })
    ).resolves.toEqual({ recorded: true });

    expect(isGroupMember).toHaveBeenCalledWith('g-1234', 'alice');
    expect(warn).toHaveBeenCalledWith(
      '[UNINVITED_ENTRY] kind=new-person reporter=alice:web-alice-1 group=g-1234 entrant=mallory:dev1 epoch=7 key=00ff11ee watched_from=4'
    );
  });

  it('prints where the device record starts: `none` when it holds none, `unstated` from an older build', async () => {
    const entry = {
      groupId: 'g-1234',
      entrant: 'mallory:dev1',
      keyFingerprint: '00',
      kind: 'new-person',
    };
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      ...entry,
      epoch: 7,
      watchedFromEpoch: null,
    });
    await controller.reportUninvitedEntry('alice', 'web-alice-1', { ...entry, epoch: 8 });
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      ...entry,
      epoch: 9,
      watchedFromEpoch: '3\n[SEND] forged',
    });

    expect(warn.mock.calls[0][0]).toContain('watched_from=none');
    expect(warn.mock.calls[1][0]).toContain('watched_from=unstated');
    expect(warn.mock.calls[2][0]).toContain('watched_from=invalid');
  });

  it('prints `-` for a kind the device decides without its record, never `unstated`', async () => {
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1234',
      entrant: 'carol:dev2',
      epoch: 3,
      kind: 'direct-peer',
    });

    expect(warn.mock.calls[0][0]).toContain('watched_from=-');
  });

  it('prints each kind members disagree on for one entry: a device that proves a return, one that cannot', async () => {
    const entry = { groupId: 'g-1234', entrant: 'mallory:dev1', epoch: 7, keyFingerprint: '00' };
    await controller.reportUninvitedEntry('alice', 'web-alice-1', { ...entry, kind: 'returning' });
    await controller.reportUninvitedEntry('bob', 'web-bob', { ...entry, kind: 'new-person' });
    await controller.reportUninvitedEntry('carol', 'web-carol', { ...entry, kind: 'new-person' });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('kind=returning');
    expect(warn.mock.calls[1][0]).toContain('kind=new-person');
  });

  it('prints no full user id for the reporter or the entrant, each device kept apart', async () => {
    const alice = 'a1'.repeat(32);
    const mallory = 'c3'.repeat(32);

    await controller.reportUninvitedEntry(alice, `web-${alice}-mh9x2k1q-a7c3`, {
      groupId: 'g-1234',
      entrant: `${mallory}:web-${mallory}-mh9x2k1q-0z9y`,
      epoch: 7,
      keyFingerprint: '00ff11ee',
      kind: 'new-person',
    });

    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).not.toContain(alice);
    expect(line).not.toContain(mallory);
    expect(line).toContain(
      'reporter=a1a1a1a1:web-a1a1a1a1-mh9x2k1q-a7c3 group=g-1234 ' +
        'entrant=c3c3c3c3:web-c3c3c3c3-mh9x2k1q-0z9y'
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
    await report('bob:dev6', 13, 'unvouched-device');

    expect(warn.mock.calls[0][0]).toContain('kind=returning');
    expect(warn.mock.calls[1][0]).toContain('kind=direct-peer');
    expect(warn.mock.calls[2][0]).toContain('kind=unstated');
    expect(warn.mock.calls[3][0]).toMatch(/^\[UNINVITED_ENTRY\] kind=invalid /);
    expect(warn.mock.calls[4][0]).toContain('kind=unvouched-device');
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

  it('counts an entry once across a deploy or a second replica: the row, not the process, remembers', async () => {
    const entry = { groupId: 'g-1234', entrant: 'mallory:dev1', epoch: 7, kind: 'new-person' };
    await controller.reportUninvitedEntry('alice', 'web-alice-1', entry);

    const afterDeploy = await makeController();
    await afterDeploy.reportUninvitedEntry('bob', 'web-bob', entry);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toContain('already counted');
  });

  it('writes the row with the values the line prints, the entrant shortened', async () => {
    const mallory = 'c3'.repeat(32);
    await controller.reportUninvitedEntry('alice', 'web-alice-1', {
      groupId: 'g-1234',
      entrant: `${mallory}:dev1`,
      epoch: 7,
      kind: 'new-person',
      watchedFromEpoch: 4,
    });

    expect(claimUninvitedEntry).toHaveBeenCalledWith({
      groupId: 'g-1234',
      entrant: 'c3c3c3c3:dev1',
      epoch: '7',
      kind: 'new-person',
      watchedFrom: '4',
    });
  });

  it('a count that could not be written is printed at ERROR with its evidence, and refused so a member reports it again', async () => {
    claimUninvitedEntry.mockRejectedValue(new Error('connection terminated'));

    await expect(
      controller.reportUninvitedEntry('alice', 'web-alice-1', {
        groupId: 'g-1234',
        entrant: 'mallory:dev1',
        epoch: 7,
        kind: 'new-person',
      })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(
      /^\[UNINVITED_ENTRY\] NOT COUNTED kind=new-person reporter=alice:web-alice-1 group=g-1234 entrant=mallory:dev1 epoch=7 .*connection terminated/
    );
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
