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
import { assertCallerOwnsDeviceOrGlobalAdmin, assertCallerOwnsUserId } from '../utils/sanitize';

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
   * The ONLY handlers allowed to read the header, each with its reason:
   * - the storage panel answers aggregates, never a person (kept);
   * - device administration and the PIN routes read or write no group, roster, invitation or
   *   message, and wait for the owner's decision (unchanged, listed in the PR of 2026-11-02).
   */
  const ALLOWED = [
    'AdminStorageController.getStorageUsage',
    'DevicesController.deleteDevice',
    'DevicesController.isDeviceRevoked',
    'DevicesController.pruneDevicePrekeys',
    'DevicesController.purgeDevicePrekeys',
    'DevicesController.updateDeviceMetadata',
    'SecurityController.changePin',
    'SecurityController.checkPinVerifier',
    'SecurityController.getPinSalt',
    'SecurityController.getPinStatus',
    'SecurityController.resetPin',
  ];

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

  it('keeps the device-administration exemption explicit, and to that helper alone', () => {
    expect(() =>
      assertCallerOwnsDeviceOrGlobalAdmin('admin', 'true', 'victim', 'refused')
    ).not.toThrow();
    expect(() =>
      assertCallerOwnsDeviceOrGlobalAdmin('admin', 'false', 'victim', 'refused')
    ).toThrow(ForbiddenException);
  });
});
