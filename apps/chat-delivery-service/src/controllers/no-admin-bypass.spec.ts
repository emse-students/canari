/// <reference types="jest" />

import { ForbiddenException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AppController } from '../app.controller';
import { AdminStorageController } from './admin-storage.controller';
import { CallsController } from './calls.controller';
import { DevicesController } from './devices.controller';
import { GifMediaController } from './gif-media.controller';
import { GifSearchController } from './gif-search.controller';
import { GroupsController } from './groups.controller';
import { HealthController } from './health.controller';
import { InternalController } from './internal.controller';
import { InvitationsController } from './invitations.controller';
import { LocksController } from './locks.controller';
import { MembersController } from './members.controller';
import { MessagingController } from './messaging.controller';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { PushController } from './push.controller';
import { SecurityController } from './security.controller';
import { assertCallerOwnsUserId } from '../utils/sanitize';

/**
 * NO PLATFORM-ADMIN BYPASS ON CONVERSATION DATA (owner, 2026-11-02).
 *
 * A global admin is a user like any other on a person's groups, rosters, invitations, queued
 * messages, history, and on the device enrolment that would route a conversation to them. The
 * route-level cases live beside each route (rosters, vouch, history); this one is the gate that
 * keeps the NEXT route honest: every handler of this service that reads `x-global-admin` is named
 * below, by an ALLOWLIST, and a new reader fails here until somebody decides which side it is on.
 */
describe('no platform-admin bypass on conversation data', () => {
  const CONTROLLERS = [
    AppController,
    AdminStorageController,
    CallsController,
    DevicesController,
    GifMediaController,
    GifSearchController,
    GroupsController,
    HealthController,
    InternalController,
    InvitationsController,
    LocksController,
    MembersController,
    MessagingController,
    NotificationPreferencesController,
    PushController,
    SecurityController,
  ];

  /**
   * The ONLY handler allowed to read the header: the storage panel, which answers aggregates and
   * never a person. Device administration and the PIN routes lost their exemption on the owner's
   * decision of 2026-11-02 - each person manages their own devices and their own PIN.
   */
  const ALLOWED = ['AdminStorageController.getStorageUsage'];

  /** Every `Class.method` whose route arguments include the `x-global-admin` header. */
  const readersOfTheHeader = (): string[] => {
    const readers: string[] = [];
    for (const controller of CONTROLLERS) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
          string,
          { data?: unknown }
        >;
        if (Object.values(args).some((a) => a.data === 'x-global-admin')) {
          readers.push(`${controller.name}.${method}`);
        }
      }
    }
    return readers.sort();
  };

  it('reads the header in the allowlisted handlers and nowhere else', () => {
    expect(readersOfTheHeader()).toEqual([...ALLOWED].sort());
  });

  it('the check is live: it sees a handler that reads the header', () => {
    // A control, so a green run above cannot be a metadata key that matches nothing.
    expect(readersOfTheHeader()).toContain('AdminStorageController.getStorageUsage');
  });

  it("refuses an admin acting on another person's data as it refuses anybody", () => {
    const asAnybody = () => assertCallerOwnsUserId('someone', 'victim', 'refused');
    expect(asAnybody).toThrow(ForbiddenException);
    // The strict assertion takes no admin flag at all: there is nothing an admin could pass.
    expect(assertCallerOwnsUserId.length).toBe(3);
  });

  /**
   * A controller with NO dependencies: every field it touches throws. A refusal must come from the
   * owner check at the top of the handler, before anything is read or written - a dependency
   * reached first would fail the case with a different error.
   */
  const bare = <T extends object>(cls: { prototype: T }): T =>
    new Proxy(Object.create(cls.prototype) as T, {
      get(target, key, receiver) {
        if (key in cls.prototype || typeof key === 'symbol') {
          return Reflect.get(target, key, receiver);
        }
        throw new Error(`dependency ${String(key)} reached before the owner check`);
      },
    });

  describe("another person's devices: an admin who is not the owner is refused", () => {
    const devices = bare(DevicesController);
    it.each([
      [
        'PATCH metadata',
        () => devices.updateDeviceMetadata('victim', 'd1', { deviceName: 'x' }, 'admin'),
      ],
      ['GET revoked', () => devices.isDeviceRevoked('victim', 'd1', 'admin')],
      ['DELETE prekeys', () => devices.purgeDevicePrekeys('victim', 'd1', 'admin')],
      [
        'POST prekeys/prune',
        () => devices.pruneDevicePrekeys('victim', 'd1', { ids: ['k'] }, 'admin'),
      ],
      ['DELETE device', () => devices.deleteDevice('victim', 'd1', undefined, 'admin', undefined)],
    ])('%s', async (_route, call) => {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("another person's PIN: an admin who is not the person is refused", () => {
    const security = bare(SecurityController);
    const verifier = 'a'.repeat(64);
    it.each([
      ['pin-check', () => security.checkPinVerifier({ userId: 'victim', verifier }, 'admin')],
      ['pin-salt', () => security.getPinSalt('victim', 'admin')],
      ['pin-status', () => security.getPinStatus('victim', 'admin')],
      [
        'pin-change',
        () =>
          security.changePin(
            { userId: 'victim', oldVerifier: verifier, newVerifier: verifier },
            'admin'
          ),
      ],
      ['pin-reset', () => security.resetPin({ userId: 'victim' }, 'admin')],
    ])('%s', async (_route, call) => {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
