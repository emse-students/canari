/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DevicesController } from './devices.controller';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { MessagingService } from '../services/messaging.service';
import { DeviceSignatureKeysService } from '../services/device-signature-keys.service';
import { HeaderAuthGuard } from '../guards/header-auth.guard';

/**
 * `register-device` ANSWERS WHETHER THE DEVICE CAN BE WOKEN, and says so when a phone cannot.
 *
 * Production, 2026-11-15: 25 of the 65 `1.6.12` phones that ran that day held no `push_token` row,
 * none had sent a registration or a report, and nothing on the server said a word - a hand-written
 * query found it. The answer below is the fact the client now re-registers on, and the line is the
 * report, carrying what the device states its last attempt came to.
 */
describe('DevicesController.registerDevice - the push registration it answers about', () => {
  let controller: DevicesController;
  let held: boolean;
  let existsBy: jest.Mock;
  const log = jest.fn();
  const warn = jest.fn();

  const BODY = { userId: 'u1', deviceId: 'd1', keyPackage: 'a2V5', deviceOs: 'android' };

  beforeEach(async () => {
    held = true;
    log.mockReset();
    warn.mockReset();
    existsBy = jest.fn(async () => held);
    const qb = {
      select: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      getRawOne: jest.fn(() => Promise.resolve({ n: '0' })),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        {
          provide: getRepositoryToken(KeyPackage),
          useValue: { findOne: jest.fn(async () => null), createQueryBuilder: jest.fn(() => qb) },
        },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: { existsBy } },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: { findOne: jest.fn(async () => null), find: jest.fn(async () => []) },
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: { query: jest.fn(async () => [{ inserted: false }]) } },
        { provide: MessagingService, useValue: {} },
        { provide: DeviceSignatureKeysService, useValue: { record: jest.fn() } },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(DevicesController);
    const logger = (controller as unknown as { logger: { log: jest.Mock; warn: jest.Mock } })
      .logger;
    logger.log = log;
    logger.warn = warn;
  });

  const missingLines = (mock: jest.Mock) =>
    mock.mock.calls.map(([line]) => String(line)).filter((l) => l.startsWith('[PUSH_MISSING]'));

  it('answers that the row is held, looked up by the account AND the device, and says nothing', async () => {
    const answer = await controller.registerDevice(BODY, 'u1');
    expect(answer).toEqual({ status: 'registered', push: { registered: true } });
    expect(existsBy).toHaveBeenCalledWith({ userId: 'u1', deviceId: 'd1' });
    expect(missingLines(warn)).toHaveLength(0);
    expect(missingLines(log)).toHaveLength(0);
  });

  it('answers registered=false when the row is gone - the fact the client re-registers on', async () => {
    held = false;
    const answer = await controller.registerDevice({ ...BODY, pushOutcome: 'registered' }, 'u1');
    expect(answer).toEqual({ status: 'registered', push: { registered: false } });
  });

  it.each([
    ['unauthorized', 'did not reach the server'],
    ['started', 'did not reach the server'],
    ['registered', 'a server-side deletion'],
  ])('a phone with no row and last=%s is ACCUSED, naming the side', async (outcome, side) => {
    held = false;
    await controller.registerDevice(
      { ...BODY, pushOutcome: outcome, deviceAppVersion: '1.6.12' },
      'u1'
    );
    const [line] = missingLines(warn);
    expect(line).toContain(`last=${outcome}`);
    expect(line).toContain('os=android build=1.6.12');
    expect(line).toContain(side);
  });

  it('a first registration of a sign-in (last=none) is expected: said at log, never accused', async () => {
    held = false;
    await controller.registerDevice({ ...BODY, pushOutcome: 'none' }, 'u1');
    expect(missingLines(warn)).toHaveLength(0);
    expect(missingLines(log)).toEqual([expect.stringContaining('last=none')]);
  });

  it('an outcome off the allowlist prints invalid, an absent one unstated', async () => {
    held = false;
    await controller.registerDevice({ ...BODY, pushOutcome: 'pwned forged line' }, 'u1');
    await controller.registerDevice(BODY, 'u1');
    expect(missingLines(warn).map((l) => l.match(/last=(\S+)/)?.[1])).toEqual([
      'invalid',
      'unstated',
    ]);
  });

  it('a browser or a desktop holds no push registration by design, and is never accused', async () => {
    held = false;
    await controller.registerDevice({ ...BODY, deviceOs: 'web' }, 'u1');
    await controller.registerDevice({ ...BODY, deviceOs: 'windows' }, 'u1');
    expect(missingLines(warn)).toHaveLength(0);
    expect(missingLines(log)).toHaveLength(0);
  });
});
