/// <reference types="jest" />

jest.mock('../internal/device-sessions', () => {
  const actual = jest.requireActual('../internal/device-sessions');
  return { ...actual, endDeviceSessions: jest.fn() };
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
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
import { revocationReasonOf } from '../utils/revocation';
import { DeviceSessionsNotEndedError, endDeviceSessions } from '../internal/device-sessions';

const endSessions = endDeviceSessions as jest.MockedFunction<typeof endDeviceSessions>;
const CALLER_SID = '0a0a0a0a-0000-4000-8000-0000000000a1';

/**
 * A BAN SAYS WHO WROTE IT, AND A DEVICE-CREATING CALL IS REFUSED ACCORDINGLY.
 *
 * One route writes `revoked_device` for two facts - the owner revoking a device, and an install
 * retiring the id its own rotation abandoned - and the client's cure differs (a wipe, or a fresh id).
 * The refusal therefore carries the cause as a CODE, and a row with no recorded cause is read as the
 * owner's. The merge of a cause into an existing row is ONE statement, asserted against PostgreSQL
 * in `040_revoked_device_reason.integration.spec.ts`; here the statement's answer is scripted.
 *
 * An owner's revocation also ends the device's sessions server-side, except the caller's own, and
 * the delete answers 503 when that could not be done.
 */
describe('DevicesController - the cause of a ban', () => {
  let controller: DevicesController;
  let revoked: { reason: string | null; revokedAt: Date; id: string } | null;
  /** What the upsert statement answers as the recorded cause. */
  let recorded: string;
  const query = jest.fn();
  const recordKeys = jest.fn().mockResolvedValue(undefined);
  const notify = jest.fn().mockResolvedValue(false);
  const purge = jest.fn().mockResolvedValue({
    groupsCleaned: 0,
    keyPackagesDeleted: 0,
    oneTimeKeyPackagesDeleted: 0,
    queuedMessagesDeleted: 0,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    revoked = null;
    recorded = 'owner';
    for (const m of [purge, recordKeys, notify, query, endSessions]) m.mockClear();
    query.mockImplementation(async () => [{ reason: recorded }]);
    endSessions.mockReset();
    endSessions.mockResolvedValue(1);
    const revokedDeviceRepo = { findOne: jest.fn(async () => revoked) };
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
        { provide: DataSource, useValue: { query } },
        {
          provide: MessagingService,
          useValue: { purgeDeviceFootprint: purge, notifyDeviceRevoked: notify },
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
    const del = (reason: string | undefined, sid: string | undefined = CALLER_SID) =>
      controller.deleteDevice('u1', 'd2', reason, 'u1', undefined, sid);
    const askedCause = () => (query.mock.calls[0][1] as unknown[])[4];

    it('asks for the owner when no reason is given - every older caller is the panel', async () => {
      await del(undefined);
      expect(askedCause()).toBe('owner');
    });

    it('asks for retired when the install retires its abandoned id', async () => {
      recorded = 'retired';
      await del('retired');
      expect(askedCause()).toBe('retired');
    });

    it("ends the device's sessions except the caller's own, then signals the device", async () => {
      await del(undefined);
      expect(endSessions).toHaveBeenCalledWith('u1', 'd2', CALLER_SID);
      expect(notify).toHaveBeenCalledWith('u1', 'd2');
    });

    it('ends them with no exception when the caller names no session', async () => {
      await controller.deleteDevice('u1', 'd2', undefined, 'u1', undefined, undefined);
      expect(endSessions).toHaveBeenCalledWith('u1', 'd2', null);
    });

    it('ends no session for a retirement - the id was the caller install’s own', async () => {
      recorded = 'retired';
      await del('retired');
      expect(endSessions).not.toHaveBeenCalled();
    });

    it("ends the sessions when a retirement met an owner's ban (the cause recorded is the owner's)", async () => {
      recorded = 'owner';
      await del('retired');
      expect(endSessions).toHaveBeenCalledWith('u1', 'd2', CALLER_SID);
    });

    it('answers 503 - never success - when the sessions could not be ended', async () => {
      endSessions.mockRejectedValue(new DeviceSessionsNotEndedError('status=500'));
      await expect(del(undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
      // The ban is recorded (the retry is idempotent); the device is not told it is done.
      expect(query).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
    });

    it('refuses an unknown reason rather than guessing it, and writes nothing', async () => {
      await expect(del('stolen')).rejects.toBeInstanceOf(BadRequestException);
      expect(query).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
    });
  });
});

describe('revocationReasonOf', () => {
  it('reads NULL and owner as owner, retired as retired', () => {
    expect(revocationReasonOf({ reason: null })).toBe('owner');
    expect(revocationReasonOf({ reason: 'owner' })).toBe('owner');
    expect(revocationReasonOf({ reason: 'retired' })).toBe('retired');
  });
});
