/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { KeyPackage, KEY_PACKAGE_LIFETIME_DAYS } from '../entities/key-package.entity';
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
 *
 * **AND "UNKNOWN" TURNED OUT TO COVER THE WHOLE ESTATE, WHICH IS NOT WHAT THAT DIRECTION IS FOR.**
 * `key_package.notAfter` is written ONLY at `register-device`; `republishKeyMaterial`, the thing a
 * client runs every 30 s, refreshes the one-time pool and never touches that row. So 683 of 719
 * rows on production were NULL on 2026-09-18 - 95% of devices exempt from the refusal above - and a
 * user's console export caught one of them served 3.88 days dead, the join failing every launch.
 * The two tables need OPPOSITE answers and the tests below say so: `one_time_key_package` is
 * insert-once, so `createdAt + 84 days` is its real lifetime and the filter is now total
 * (migration 025); `key_package` is updated in place, so the same sum would certify a dead package
 * as live, and only the one-way half of it is sound - see `lastResortDeadline`.
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
      findOne: jest.fn().mockResolvedValue(
        over.device === null
          ? null
          : {
              userId: 'u1',
              deviceId: 'd1',
              keyPackage: 'THE-STATIC-ROW',
              // A REAL ROW ALWAYS HAS ONE - it is a `@CreateDateColumn` - and the guard now reads
              // it, so a stub without it would be testing a row that cannot exist.
              createdAt: new Date(),
              ...over.device,
            }
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

    it('serves a last-resort whose expiry is unknown and whose row is young, because that is unproven', async () => {
      // Every row written before migration 024, and every row an old client still writes. Reading a
      // NULL as "assume the worst" would lock out exactly the devices nobody has a fact about, and
      // `registerDevice` resets `createdAt` while the client republishes a package it already holds
      // - so a young row proves nothing in EITHER direction and the package is served.
      const { controller } = await build({ device: { notAfter: null, createdAt: new Date() } });
      const served = await controller.getDeviceKeyPackage('u1', 'd1');
      expect(served.keyPackage).toBe('THE-STATIC-ROW');
    });

    /**
     * THE ARM THAT NEEDS NO CLIENT TO SPEAK, and without it 95% of production was exempt from the
     * refusal above: `notAfter` is written only by `register-device`, so 683 of 719 rows were NULL
     * on 2026-09-18 and the guard never fired on any of them. A user's console export that day
     * caught one being served 3.88 days dead, the join failing on every launch.
     *
     * The package is at least as old as its row, so one full lifetime past `createdAt` it is
     * certainly gone. The inference does not run the other way and must not: a row can carry
     * today's date and a package that elapses in four days, which is exactly why migration 024
     * refused to backfill this column.
     */
    it('refuses an undated last-resort whose row is older than a package can live', async () => {
      const { controller } = await build({
        device: {
          notAfter: null,
          createdAt: new Date(Date.now() - (KEY_PACKAGE_LIFETIME_DAYS + 1) * 24 * HOUR),
        },
      });
      await expect(controller.getDeviceKeyPackage('u1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('lets a reported date that has NOT elapsed outrank the bound, because it is the better fact', async () => {
      // A device that re-registered today with a package minted long ago: the row is old, so the
      // bound would condemn it, but the client has read the package's own lifetime and it is live.
      const { controller } = await build({
        device: {
          notAfter: new Date(Date.now() + HOUR),
          createdAt: new Date(Date.now() - (KEY_PACKAGE_LIFETIME_DAYS + 1) * 24 * HOUR),
        },
      });
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
      // NO "UNKNOWN" ARM: every row answers, whether or not a client ever sent a date.
      expect(sql).not.toContain('IS NULL');
      expect(sql).toContain('COALESCE(otkp."notAfter"');
      expect(sql).toContain('> now()');

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
      // NO "UNKNOWN" ARM: every row answers, whether or not a client ever sent a date.
      expect(sql).not.toContain('IS NULL');
      expect(sql).toContain('COALESCE(otkp."notAfter"');
      expect(sql).toContain('> now()');
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

    it('still accepts the bare string an older client sends, and DATES it from the insert', async () => {
      // THE SHIM, AND THE WHOLE OF IT. A client from before this change cannot be made to send a
      // date; refusing it would take a working device's pool away over a fact nobody needs.
      //
      // BUT STORING A NULL WAS NOT THE ONLY WAY TO ACCEPT IT, and it was the expensive one: 577
      // undated rows stood on production on 2026-09-18, every one written AFTER migration 024
      // backfilled the table on exactly this arithmetic, and each was a row no read site could
      // judge for 84 days. This table is insert-once, so the sum IS the package's lifetime.
      const before = Date.now();
      const saved = await publish(['AAA', 'BBB']);
      const after = Date.now();
      expect(saved.map((r) => r.keyPackage)).toEqual(['AAA', 'BBB']);
      const span = KEY_PACKAGE_LIFETIME_DAYS * 24 * HOUR;
      for (const row of saved) {
        expect(row.notAfter).not.toBeNull();
        expect(row.notAfter!.getTime()).toBeGreaterThanOrEqual(before + span);
        expect(row.notAfter!.getTime()).toBeLessThanOrEqual(after + span);
      }
    });

    it('dates an unreadable date the same way rather than refusing the batch', async () => {
      // Garbage from a client is not a date, and it is not a reason to drop the row either. It
      // lands on the bound, like a client that said nothing at all.
      const saved = await publish([{ keyPackage: 'AAA', notAfter: 'the day before yesterday' }]);
      expect(saved[0].notAfter).not.toBeNull();
      expect(saved[0].notAfter!.getTime()).toBeGreaterThan(Date.now());
    });

    it('still refuses a batch with no key package in it', async () => {
      await expect(publish([{ notAfter: new Date().toISOString() }])).rejects.toThrow(
        /non-empty base64/
      );
    });
  });
});
