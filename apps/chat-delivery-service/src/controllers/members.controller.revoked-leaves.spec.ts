/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import {
  MembersController,
  REVOKED_LEAVES_LIMIT_PER_MINUTE,
  REVOKED_LEAVES_MAX_IDENTITIES,
} from './members.controller';

/**
 * `POST /mls/groups/:groupId/revoked-leaves` names which leaves of a tree belong to a revoked
 * device - for a KEY-DISTRIBUTION group too, which `group-rosters` never answers. It is asked only
 * by an admitted member, about identities it already sees, and answers an allowlist.
 */
describe('MembersController.getRevokedLeaves', () => {
  let groups: { findOne: jest.Mock };
  let devices: { findOne: jest.Mock; find: jest.Mock };
  let seats: { findOne: jest.Mock; find: jest.Mock };
  let revoked: { find: jest.Mock };
  let heldWhenRevoked: { find: jest.Mock };
  let controller: MembersController;

  beforeEach(() => {
    // A community key group, and the caller holds an active device row in it.
    groups = {
      findOne: jest.fn().mockResolvedValue({
        id: 'kg-1',
        distributionWorkspaceId: 'ws-1',
        distributionChannelId: null,
      }),
    };
    devices = {
      findOne: jest.fn().mockResolvedValue({ groupId: 'kg-1', userId: 'alice' }),
      // The users bound to the group by a device row: alice and bob.
      find: jest.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'Bob' }]),
    };
    seats = { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) };
    revoked = {
      find: jest.fn().mockResolvedValue([{ userId: 'bob', deviceId: 'phone-1' }]),
    };
    // The key groups a revoked device held when its revocation purged its rows: none by default.
    heldWhenRevoked = { find: jest.fn().mockResolvedValue([]) };
    controller = new MembersController(
      seats as never,
      {} as never,
      groups as never,
      {} as never,
      devices as never,
      {} as never,
      {} as never,
      revoked as never,
      heldWhenRevoked as never,
      {} as never,
      {} as never
    );
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('names, as sent, exactly the leaves of a key group whose device is revoked', async () => {
    const got = await controller.getRevokedLeaves(
      'kg-1',
      { identities: ['alice:web-1', 'BOB:phone-1', 'bob:laptop-2'] },
      'alice'
    );

    // The user half without case, the device half exact; answered in the caller's own spelling.
    expect(got).toEqual({ revoked: ['BOB:phone-1'] });
    // ONE query, under the ban window.
    expect(revoked.find).toHaveBeenCalledTimes(1);
    expect(revoked.find.mock.calls[0][0].where.revokedAt).toBeDefined();
  });

  it('answers a REAL-LENGTH identity - longer than the generic 128 bound, which refused every one', async () => {
    // The shape `BaseMlsService.generateDeviceId` mints: a 64-hex user, and a device id embedding it.
    const bob = 'b0b'.padEnd(64, '7');
    const web = `${bob}:web-${bob}-mh9x2k1q-a7c3`;
    const tauri = `${bob}:tauri-${bob}-mh9x2k1q-0z9y`;
    expect(web.length).toBe(147);
    expect(tauri.length).toBe(149);
    devices.find.mockResolvedValue([{ userId: 'alice' }, { userId: bob }]);
    revoked.find.mockResolvedValue([{ userId: bob, deviceId: `tauri-${bob}-mh9x2k1q-0z9y` }]);

    const got = await controller.getRevokedLeaves('kg-1', { identities: [web, tauri] }, 'alice');

    expect(got).toEqual({ revoked: [tauri] });
  });

  it('answers nothing about a user bound to no device row or seat of this group', async () => {
    revoked.find.mockResolvedValue([{ userId: 'stranger', deviceId: 'lost-1' }]);

    const got = await controller.getRevokedLeaves(
      'kg-1',
      { identities: ['stranger:lost-1'] },
      'alice'
    );

    // A member of one group cannot read the revocations of people outside it.
    expect(got).toEqual({ revoked: [] });
    expect(revoked.find).not.toHaveBeenCalled();
    expect(devices.find.mock.calls[0][0].where.groupId).toBe('kg-1');
  });

  it('refuses a caller who holds no seat in the group, before reading any revocation', async () => {
    devices.findOne.mockResolvedValue(null);

    await expect(
      controller.getRevokedLeaves('kg-1', { identities: ['bob:phone-1'] }, 'mallory')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(revoked.find).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a list, or more than the cap', async () => {
    await expect(controller.getRevokedLeaves('kg-1', {}, 'alice')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      controller.getRevokedLeaves('kg-1', { identities: 'bob:phone-1' }, 'alice')
    ).rejects.toBeInstanceOf(BadRequestException);
    const tooMany = Array.from({ length: REVOKED_LEAVES_MAX_IDENTITIES + 1 }, (_, i) => `u:${i}`);
    await expect(
      controller.getRevokedLeaves('kg-1', { identities: tooMany }, 'alice')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(revoked.find).not.toHaveBeenCalled();
  });

  it('SKIPS a crafted credential instead of refusing the batch - the other leaves are still answered', async () => {
    const warn = jest.spyOn(controller['logger'], 'warn');
    const crafted = [
      'bob:tauri:x',
      'bob',
      'mallory:dev 1',
      'mallory:dév',
      `eve:${'d'.repeat(129)}`,
      '',
      42,
      null,
    ];

    const got = await controller.getRevokedLeaves(
      'kg-1',
      { identities: [...crafted, 'BOB:phone-1', 'alice:web-1'] },
      'alice'
    );

    expect(got).toEqual({ revoked: ['BOB:phone-1'] });
    // Said at warn, by count only - no identity in the line.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('asked=2 outside=0 revoked=1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed=8'));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/mallory|eve:|dddd/);
  });

  it('says a batch of malformed identities alone, and reads nothing', async () => {
    const warn = jest.spyOn(controller['logger'], 'warn');

    await expect(
      controller.getRevokedLeaves('kg-1', { identities: ['x:y:z'] }, 'alice')
    ).resolves.toEqual({ revoked: [] });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('asked=0 malformed=1'));
    expect(revoked.find).not.toHaveBeenCalled();
    expect(devices.find).not.toHaveBeenCalled();
  });

  it('says a converged answer at debug, and a revoked or unbound leaf at log level', async () => {
    const log = jest.spyOn(controller['logger'], 'log');
    const debug = jest.spyOn(controller['logger'], 'debug').mockImplementation(() => undefined);

    await controller.getRevokedLeaves('kg-1', { identities: ['alice:web-1'] }, 'alice');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('outside=0 revoked=0'));
    expect(log).not.toHaveBeenCalled();

    await controller.getRevokedLeaves('kg-1', { identities: ['bob:phone-1'] }, 'alice');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('revoked=1'));

    await controller.getRevokedLeaves('kg-1', { identities: ['stranger:x'] }, 'alice');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('outside=1 revoked=0'));
  });

  it('binds a user whose every device row here was purged only once a device of theirs is back', async () => {
    // THE BINDING IS THE DEVICE ROWS (a key group has no seats): a user with no row here is not
    // bound, and nothing about them is answered.
    devices.find.mockResolvedValue([{ userId: 'alice' }]);
    await expect(
      controller.getRevokedLeaves('kg-1', { identities: ['bob:phone-1'] }, 'alice')
    ).resolves.toEqual({ revoked: [] });

    // Their new install's row in the group - pending is enough - binds them again.
    devices.find.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
    await expect(
      controller.getRevokedLeaves('kg-1', { identities: ['bob:phone-1'] }, 'alice')
    ).resolves.toEqual({ revoked: ['bob:phone-1'] });
  });

  it("binds the EXACT device a revocation recorded as having held the group, and none of its user's others", async () => {
    // THE SOLE-DEVICE CASE: bob's only device was revoked, so its purge left him no row here - but
    // the purge recorded that THIS device held the key group (`dm_revoked_device_groups`).
    devices.find.mockResolvedValue([{ userId: 'alice' }]);
    heldWhenRevoked.find.mockResolvedValue([{ userId: 'bob', deviceId: 'phone-1' }]);
    revoked.find.mockResolvedValue([
      { userId: 'bob', deviceId: 'phone-1' },
      { userId: 'bob', deviceId: 'tablet-9' },
    ]);

    const got = await controller.getRevokedLeaves(
      'kg-1',
      { identities: ['BOB:phone-1', 'bob:tablet-9'] },
      'alice'
    );

    // The recorded device is answered (in the caller's spelling); bob's other revoked device was
    // never recorded here, so bob is not bound for it.
    expect(got).toEqual({ revoked: ['BOB:phone-1'] });
    expect(heldWhenRevoked.find.mock.calls[0][0].where.groupId).toBe('kg-1');
  });

  it('answers an empty list without reading the revocations', async () => {
    await expect(controller.getRevokedLeaves('kg-1', { identities: [] }, 'alice')).resolves.toEqual(
      { revoked: [] }
    );
    expect(revoked.find).not.toHaveBeenCalled();
  });
});

describe('POST /mls/groups/:groupId/revoked-leaves rate limit', () => {
  it('runs the user throttler after the guard that proves the user id, at its own limit', () => {
    const handler = Object.getOwnPropertyDescriptor(MembersController.prototype, 'getRevokedLeaves')
      ?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      HeaderAuthGuard,
      UserThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
      REVOKED_LEAVES_LIMIT_PER_MINUTE
    );
  });
});
