/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
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
import { stubPool } from '../testing/queryBuilder';

/**
 * ONE 404, THREE FACTS - AND THE CALLER ACTS DIFFERENTLY ON EACH.
 *
 * `/key-package` answers 404 when the device is revoked, when nothing was ever registered for it,
 * and (since 2026-09-16) when everything it published has elapsed. The three were indistinguishable
 * from the outside, so the inviter reported all of them as "deregistered" and retired the pending
 * membership on all of them - including the one that is TEMPORARY and repairs itself on the
 * device's next connection.
 *
 * A distinction carried in prose is a distinction exactly one call site will make. These cases pin
 * it as data, classified where it is known: in the body of the 404 the resolver threw.
 */
describe('DevicesController - a refusal says which of the three it is', () => {
  const HOUR = 60 * 60 * 1000;

  const build = async (over: { device?: Partial<KeyPackage> | null; revoked?: boolean }) => {
    const pool = stubPool(null);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        {
          provide: getRepositoryToken(KeyPackage),
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue(
                over.device === null
                  ? null
                  : { userId: 'u1', deviceId: 'd1', keyPackage: 'THE-STATIC-ROW', ...over.device }
              ),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: {
            findOne: jest.fn().mockResolvedValue(over.revoked ? { userId: 'u1' } : null),
            find: jest.fn(() => []),
          },
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: pool },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = module.get<DevicesController>(DevicesController);
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    return controller;
  };

  /** The 404's body, which is where the reason travels. */
  const refusalOf = async (controller: DevicesController): Promise<Record<string, unknown>> => {
    try {
      await controller.getDeviceKeyPackage('u1', 'd1');
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundException);
      return (e as NotFoundException).getResponse() as Record<string, unknown>;
    }
    throw new Error('expected a refusal');
  };

  it('says `expired` for a device whose last-resort has elapsed - the TEMPORARY one', async () => {
    const controller = await build({ device: { notAfter: new Date(Date.now() - HOUR) } });
    expect(await refusalOf(controller)).toMatchObject({ statusCode: 404, reason: 'expired' });
  });

  it('says `unregistered` when nothing was ever published for the pair', async () => {
    const controller = await build({ device: null });
    expect(await refusalOf(controller)).toMatchObject({ reason: 'unregistered' });
  });

  it('says `revoked`, and says it before reading anything else', async () => {
    const controller = await build({
      device: { notAfter: new Date(Date.now() + HOUR) },
      revoked: true,
    });
    expect(await refusalOf(controller)).toMatchObject({ reason: 'revoked' });
  });

  it('still carries a human message alongside the reason', async () => {
    const controller = await build({ device: null });
    expect(String((await refusalOf(controller)).message)).toContain('u1:d1');
  });

  /** The reason must not leak into the success path, which older clients parse strictly. */
  it('serves a live package with no reason attached', async () => {
    const controller = await build({ device: { notAfter: new Date(Date.now() + HOUR) } });
    const served = await controller.getDeviceKeyPackage('u1', 'd1');
    expect(served.keyPackage).toBe('THE-STATIC-ROW');
    expect(served).not.toHaveProperty('reason');
  });
});
