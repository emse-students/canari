/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DevicesController } from './devices.controller';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { DeviceSignatureKeysService } from '../services/device-signature-keys.service';
import { mergedRevocationReason, revocationReasonOf } from '../utils/revocation';

/**
 * A BAN SAYS WHO WROTE IT, AND A DEVICE-CREATING CALL IS REFUSED ACCORDINGLY.
 *
 * One route writes `revoked_device` for two facts - the owner revoking a device, and an install
 * retiring the id its own rotation abandoned - and the client's cure differs (a wipe, or a fresh id).
 * The refusal therefore carries the cause as a CODE, a row with no recorded cause is read as the
 * owner's, and an owner's active ban is never downgraded by a later "retired" call.
 */
describe('DevicesController - the cause of a ban', () => {
  let controller: DevicesController;
  let revoked: { reason: string | null; revokedAt: Date; id: string } | null;
  let saved: Array<Record<string, unknown>>;
  const recordKeys = jest.fn().mockResolvedValue(undefined);
  const purge = jest.fn().mockResolvedValue({
    groupsCleaned: 0,
    keyPackagesDeleted: 0,
    oneTimeKeyPackagesDeleted: 0,
    queuedMessagesDeleted: 0,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    revoked = null;
    saved = [];
    purge.mockClear();
    recordKeys.mockClear();
    const revokedDeviceRepo = {
      findOne: jest.fn(async () => revoked),
      save: jest.fn(async (row: Record<string, unknown>) => {
        saved.push(row);
        return row;
      }),
      create: jest.fn((v: unknown) => v),
    };
    const oneTimeKeyPackageRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => v),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: { save: jest.fn() } },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: oneTimeKeyPackageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
        {
          provide: MessagingService,
          useValue: {
            purgeDeviceFootprint: purge,
            notifyDeviceRevoked: jest.fn().mockResolvedValue(false),
          },
        },
        { provide: DeviceSignatureKeysService, useValue: { record: recordKeys } },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(DevicesController);
  });

  const BODY = { userId: 'u1', deviceId: 'd1', keyPackage: 'a2V5' };
  const active = (reason: string | null) => ({ id: 'r1', reason, revokedAt: new Date() });

  describe('register-device', () => {
    it('answers DEVICE_REVOKED_BY_OWNER for an id its owner revoked', async () => {
      revoked = active('owner');
      await expect(controller.registerDevice(BODY, 'u1', undefined)).rejects.toMatchObject({
        status: 403,
        response: { code: 'DEVICE_REVOKED_BY_OWNER', reason: 'owner' },
      });
    });

    it('answers DEVICE_REVOKED with reason retired for an id its own install retired', async () => {
      revoked = active('retired');
      await expect(controller.registerDevice(BODY, 'u1', undefined)).rejects.toMatchObject({
        status: 403,
        response: { code: 'DEVICE_REVOKED', reason: 'retired' },
      });
    });

    it('reads a ban written before the cause was recorded as the owner', async () => {
      revoked = active(null);
      await expect(controller.registerDevice(BODY, 'u1', undefined)).rejects.toMatchObject({
        response: { code: 'DEVICE_REVOKED_BY_OWNER' },
      });
    });
  });

  describe('the prekey upload', () => {
    it('is refused for a banned id, with the same typed refusal, and stores nothing', async () => {
      revoked = active('owner');
      const body = {
        userId: 'u1',
        deviceId: 'd1',
        keyPackages: [{ keyPackage: 'a2V5', notAfter: null }],
      };
      await expect(controller.registerDevicePrekeys(body, 'u1', undefined)).rejects.toMatchObject({
        status: 403,
        response: { code: 'DEVICE_REVOKED_BY_OWNER' },
      });
      expect(recordKeys).not.toHaveBeenCalled();
    });
  });

  describe('DELETE device', () => {
    it('records the owner when no reason is given - every older caller is the panel', async () => {
      await controller.deleteDevice('u1', 'd2', undefined, 'u1', undefined);
      expect(saved[0]).toMatchObject({ deviceId: 'd2', reason: 'owner' });
    });

    it('records retired when the install retires its abandoned id', async () => {
      await controller.deleteDevice('u1', 'd2', 'retired', 'u1', undefined);
      expect(saved[0]).toMatchObject({ deviceId: 'd2', reason: 'retired' });
    });

    it("never downgrades an owner's active ban to retired", async () => {
      revoked = active('owner');
      await controller.deleteDevice('u1', 'd2', 'retired', 'u1', undefined);
      expect(saved[0]).toMatchObject({ reason: 'owner', id: 'r1' });
    });

    it('refuses an unknown reason rather than guessing it, and writes nothing', async () => {
      await expect(
        controller.deleteDevice('u1', 'd2', 'stolen', 'u1', undefined)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(saved).toHaveLength(0);
      expect(purge).not.toHaveBeenCalled();
    });
  });
});

describe('revocation cause helpers', () => {
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo);

  it('reads NULL and owner as owner, retired as retired', () => {
    expect(revocationReasonOf({ reason: null })).toBe('owner');
    expect(revocationReasonOf({ reason: 'owner' })).toBe('owner');
    expect(revocationReasonOf({ reason: 'retired' })).toBe('retired');
  });

  it('keeps an active owner (or unknown) ban against a retire, and upgrades a retired one', () => {
    expect(mergedRevocationReason({ reason: 'owner', revokedAt: at(0) }, 'retired', now)).toBe(
      'owner'
    );
    expect(mergedRevocationReason({ reason: null, revokedAt: at(0) }, 'retired', now)).toBe(
      'owner'
    );
    expect(mergedRevocationReason({ reason: 'retired', revokedAt: at(0) }, 'owner', now)).toBe(
      'owner'
    );
    expect(mergedRevocationReason(null, 'retired', now)).toBe('retired');
  });

  it('lets a lapsed owner ban start over with the new cause, as its date does', () => {
    const lapsed = at(11 * 365 * 24 * 60 * 60 * 1000);
    expect(mergedRevocationReason({ reason: 'owner', revokedAt: lapsed }, 'retired', now)).toBe(
      'retired'
    );
  });
});
