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
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { DEVICE_ENROLMENT_GRACE_MS, RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * WHAT THE DEVICE CAP COUNTS.
 *
 * The limit used to be compared against `key_package` rows inside the 90-day retention window, so
 * the quantity it bounded was an account's ENROLMENT ATTEMPTS. On production (2026-09-12) 367 of
 * 667 enrolments carried no membership and no push token, and the rule's only victim in the whole
 * estate was an account with fifteen enrolments, zero group memberships and zero push tokens - a
 * user refused a device because he had failed to get one working fifteen times.
 *
 * The predicate is the fix, so the predicate is what is asserted here: the STATEMENT the controller
 * builds, because that is where the question is actually asked. A behavioural test can only observe
 * the number the database hands back, which is the one thing that was never in doubt.
 */
describe('DevicesController - the cap counts live devices', () => {
  let controller: DevicesController;
  let sql: string[];
  let params: Record<string, unknown>;
  let selected: string;
  let excluded: string | undefined;

  const BODY = { userId: 'u1', deviceId: 'd-new', keyPackage: 'a2V5' };

  beforeEach(async () => {
    sql = [];
    params = {};
    selected = '';
    excluded = undefined;

    const qb = {
      select: jest.fn((expr: string) => {
        selected = expr;
        return qb;
      }),
      where: jest.fn((clause: string, p: Record<string, unknown>) => {
        sql.push(clause);
        Object.assign(params, p);
        return qb;
      }),
      andWhere: jest.fn((clause: string, p?: Record<string, unknown>) => {
        sql.push(clause);
        if (p) {
          Object.assign(params, p);
          if (typeof p.excludeDeviceId === 'string') excluded = p.excludeDeviceId;
        }
        return qb;
      }),
      getRawOne: jest.fn(() => Promise.resolve({ n: '0' })),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        {
          provide: getRepositoryToken(KeyPackage),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue({}),
            create: jest.fn((v) => v),
            createQueryBuilder: jest.fn(() => qb),
          },
        },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn(() => []) },
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
  });

  /** Registration runs far enough to have asked the cap its question. */
  const register = () => controller.registerDevice(BODY, 'u1', undefined);

  it('counts DEVICES, not key-package rows', async () => {
    await register();
    expect(selected).toContain('COUNT(DISTINCT');
    expect(selected).toContain('deviceId');
  });

  it('counts a device that holds an ACTIVE group membership - that is what costs a tree leaf', async () => {
    await register();
    const where = sql.join('\n');
    expect(where).toContain('dm_device_group_memberships');
    // A `pending` membership is an invitation nobody accepted; it holds no leaf and must not count.
    expect(where).toContain("status = 'active'");
  });

  it('counts a device that holds a push token - the other fact a working device writes', async () => {
    await register();
    expect(sql.join('\n')).toContain('push_token');
  });

  it('counts a freshly enrolled device for the grace window, so a burst is still bounded', async () => {
    const before = Date.now();
    await register();
    const cutoff = params.graceCutoff as Date;

    expect(cutoff).toBeInstanceOf(Date);
    // Asserted as a WINDOW around the call, never as a wall-clock instant.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - DEVICE_ENROLMENT_GRACE_MS - 5_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - DEVICE_ENROLMENT_GRACE_MS + 5_000);
  });

  it('does NOT count the device being registered - it is already paid for', async () => {
    await register();
    expect(excluded).toBe('d-new');
    expect(sql.join('\n')).toContain('!= :excludeDeviceId');
  });

  it('does not fall back on the retention window, which is what made attempts look like devices', async () => {
    await register();
    const cutoff = params.graceCutoff as Date;
    const age = Date.now() - cutoff.getTime();
    expect(age).toBeLessThan(RETENTION_WINDOW_MS);
  });

  it('never treats `updatedAt` as liveness - nothing writes it on the device behalf', async () => {
    await register();
    expect(sql.join('\n')).not.toContain('updatedAt');
  });
});
