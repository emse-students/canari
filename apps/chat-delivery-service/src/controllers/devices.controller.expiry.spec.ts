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
import { stubPool, stubQueryBuilder } from '../testing/queryBuilder';

/**
 * A PACKAGE PAST ITS LIFETIME IS NOT A PACKAGE, AND UNTIL 2026-09-16 THIS SERVICE COULD NOT SAY SO.
 *
 * The expiry lives inside the serialized MLS KeyPackage and only the client's WASM crate can parse
 * one, so both tables held an opaque base64 string. The server served elapsed packages, the joiner
 * refused them with `LifetimeError(Expired)`, and the invitation was neither satisfied nor
 * abandoned - it retried on every launch, for ever. Two production accounts were in that state on
 * 2026-09-16, and 171 aged one-time rows sat at the FRONT of five devices' queues, each consumed by
 * the attempt that failed on it.
 *
 * Migration 024 gives both tables a `notAfter` the client now writes. These tests pin what the
 * column is FOR - the three reads that decide whether a join can happen at all - and, above all,
 * they pin the direction of the unknown: a NULL is "not known to be expired", never "assume the
 * worst", because refusing a package that works costs a join that would have succeeded.
 */
describe('DevicesController - a key package past its lifetime', () => {
  const HOUR = 60 * 60 * 1000;

  const build = async (over: {
    device?: Partial<KeyPackage> | null;
    pool?: unknown;
    otkpRepo?: unknown;
  }) => {
    const pool = stubPool(over.pool ?? null);
    const keyPackageRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          over.device === null
            ? null
            : { userId: 'u1', deviceId: 'd1', keyPackage: 'THE-STATIC-ROW', ...over.device }
        ),
      find: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: over.otkpRepo ?? {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn(() => []) },
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
    return { controller, pool, keyPackageRepo };
  };

  describe('serving one', () => {
    it('refuses an elapsed last-resort instead of handing out a Welcome nobody can open', async () => {
      const { controller } = await build({
        device: { notAfter: new Date(Date.now() - HOUR) },
      });
      // A 404 IS THE POINT. The adder can act on "this device has nothing usable"; it cannot act on
      // a package that every joiner is entitled to refuse, which is why the old behaviour retried
      // on every launch and never ended.
      await expect(controller.getDeviceKeyPackage('u1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('serves a last-resort that is still live', async () => {
      const { controller } = await build({
        device: { notAfter: new Date(Date.now() + HOUR) },
      });
      const served = await controller.getDeviceKeyPackage('u1', 'd1');
      expect(served.keyPackage).toBe('THE-STATIC-ROW');
    });

    it('serves a last-resort whose expiry is unknown, because unknown is not expired', async () => {
      // Every row written before migration 024, and every row an old client still writes. Reading a
      // NULL as "assume the worst" would lock out exactly the devices nobody has a fact about.
      const { controller } = await build({ device: { notAfter: null } });
      const served = await controller.getDeviceKeyPackage('u1', 'd1');
      expect(served.keyPackage).toBe('THE-STATIC-ROW');
    });

    it('asks the pool for live packages only, and spends the shortest-lived of them first', async () => {
      const { controller, pool } = await build({
        pool: { id: 'otkp-1', keyPackage: 'A-POOLED-ONE' },
      });
      const served = await controller.getDeviceKeyPackage('u1', 'd1');
      expect(served.keyPackage).toBe('A-POOLED-ONE');

      const sql = pool.builder.calls
        .filter((c) => c.method === 'where' || c.method === 'andWhere')
        .map((c) => String(c.args[0]))
        .join(' AND ');
      expect(sql).toContain('"notAfter" IS NULL OR otkp."notAfter" > now()');

      // `createdAt ASC` said "nearest to expiry" by proxy and said it wrong: it could not tell an
      // old package from a dead one, and the row is DELETED as it is served either way.
      const order = pool.builder.calls.find((c) => c.method === 'orderBy');
      expect(String(order?.args[0])).toContain('notAfter');
    });

    it('drops a device with nothing usable from the invite list rather than offering it', async () => {
      // The client throws "no active device found", which reaches a person. The device comes back
      // by itself: it mints and re-registers on its next connection, and `registerDevice` restores
      // the pending membership for every group its owner is already in.
      const { controller, keyPackageRepo } = await build({
        device: { notAfter: new Date(Date.now() - HOUR) },
      });
      keyPackageRepo.find.mockResolvedValue([
        { userId: 'u1', deviceId: 'd1', keyPackage: 'THE-STATIC-ROW', createdAt: new Date() },
      ]);
      const devices = await controller.getUserDevices('u1');
      expect(devices).toEqual([]);
    });
  });

  describe('counting them', () => {
    it('counts only what a peer could actually be served', async () => {
      // This count is what the client subtracts from fifty before minting. Counting elapsed rows as
      // available is how a device ends up holding a full pool that refuses every peer.
      const builder = stubQueryBuilder({ getCount: 7 });
      const { controller } = await build({
        otkpRepo: { createQueryBuilder: () => builder },
      });
      await expect(controller.getPrekeyCount('u1', 'd1')).resolves.toEqual({ count: 7 });
      const sql = builder.calls
        .filter((c) => c.method === 'where' || c.method === 'andWhere')
        .map((c) => String(c.args[0]))
        .join(' AND ');
      expect(sql).toContain('"notAfter" IS NULL OR otkp."notAfter" > now()');
    });
  });

  describe('accepting them', () => {
    const publish = async (keyPackages: unknown) => {
      const saved: unknown[] = [];
      const { controller } = await build({
        otkpRepo: {
          create: (row: unknown) => row,
          save: async (rows: unknown[]) => {
            saved.push(...rows);
            return rows;
          },
        },
      });
      await controller.registerDevicePrekeys({ userId: 'u1', deviceId: 'd1', keyPackages }, 'u1');
      return saved as { keyPackage: string; notAfter: Date | null }[];
    };

    it('stores the expiry a current client sends', async () => {
      const when = new Date(Date.now() + 84 * 24 * HOUR);
      const saved = await publish([{ keyPackage: 'AAA', notAfter: when.toISOString() }]);
      expect(saved).toHaveLength(1);
      expect(saved[0].keyPackage).toBe('AAA');
      expect(saved[0].notAfter?.getTime()).toBe(when.getTime());
    });

    it('still accepts the bare string an older client sends, and stores it undated', async () => {
      // THE SHIM, AND THE WHOLE OF IT. A client from before this change cannot be made to send a
      // date; refusing it would take a working device's pool away over a fact nobody needs.
      const saved = await publish(['AAA', 'BBB']);
      expect(saved.map((r) => r.keyPackage)).toEqual(['AAA', 'BBB']);
      expect(saved.every((r) => r.notAfter === null)).toBe(true);
    });

    it('stores an unreadable date as unknown rather than refusing the batch', async () => {
      const saved = await publish([{ keyPackage: 'AAA', notAfter: 'the day before yesterday' }]);
      expect(saved[0].notAfter).toBeNull();
    });

    it('still refuses a batch with no key package in it', async () => {
      await expect(publish([{ notAfter: new Date().toISOString() }])).rejects.toThrow(
        /non-empty base64/
      );
    });
  });
});
