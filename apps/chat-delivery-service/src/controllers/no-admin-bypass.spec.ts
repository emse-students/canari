/// <reference types="jest" />

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { MODULE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { DevicesController } from './devices.controller';
import { MembersController } from './members.controller';
import { SecurityController } from './security.controller';
import { assertCallerOwnsUserId } from '../utils/sanitize';

/**
 * NO PLATFORM-ADMIN BYPASS ON CONVERSATION DATA (owner, 2026-11-02).
 *
 * A global admin is a user like any other on a person's groups, rosters, invitations, queued
 * messages, history, devices and PIN. The route-level cases live beside each route (rosters, vouch,
 * history) and below (devices, PIN); this file is the gate that keeps the NEXT route honest, by two
 * independent readings that both have to agree with ONE allowlist:
 *  - the route metadata of every controller AppModule registers - read from the module, never from
 *    a list kept here, so a new controller is covered the day it is registered;
 *  - the SOURCE, for the header named anywhere at all - a `@Req()` read, a guard, a middleware or a
 *    whole `@Headers()` object never show up as a named route argument.
 */
describe('no platform-admin bypass on conversation data', () => {
  const HEADER = 'x-global-admin';
  const SRC = join(__dirname, '..');

  /**
   * The ONLY handler allowed to read the header: the storage panel, which answers aggregates and
   * never a person. Device administration and the PIN routes lost their exemption on the owner's
   * decision of 2026-11-02 - each person manages their own devices and their own PIN.
   */
  const ALLOWED = ['AdminStorageController.getStorageUsage'];
  /** The one source file that may name the header: the allowed handler's own. */
  const ALLOWED_SOURCE = 'controllers/admin-storage.controller.ts';

  type ModuleLike = { module?: object; controllers?: object[]; imports?: unknown[] };

  /** Every controller class AppModule registers, through its imported modules too. */
  const registeredControllers = async (): Promise<Array<{ name: string; prototype: object }>> => {
    // AppModule's TypeORM options read this at import time; nothing connects here.
    process.env.POSTGRES_URL ??= 'postgres://unused@localhost:1/unused';
    const { AppModule } = await import('../app.module');
    const found = new Set<{ name: string; prototype: object }>();
    const seen = new Set<unknown>();
    const walk = (mod: unknown): void => {
      if (!mod || seen.has(mod)) return;
      seen.add(mod);
      const dynamic = mod as ModuleLike;
      const cls = typeof mod === 'function' ? (mod as object) : dynamic.module;
      const read = (key: string): unknown[] =>
        (cls ? (Reflect.getMetadata(key, cls) as unknown[] | undefined) : undefined) ?? [];
      for (const c of [...read(MODULE_METADATA.CONTROLLERS), ...(dynamic.controllers ?? [])]) {
        found.add(c as { name: string; prototype: object });
      }
      for (const i of [...read(MODULE_METADATA.IMPORTS), ...(dynamic.imports ?? [])]) walk(i);
    };
    walk(AppModule);
    return [...found];
  };

  /** Every `Class.method` whose route arguments name the header, in any letter case. */
  const readersOfTheHeader = (
    controllers: Array<{ name: string; prototype: object }>
  ): string[] => {
    const readers: string[] = [];
    for (const controller of controllers) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
          string,
          { data?: unknown }
        >;
        const named = Object.values(args).some(
          (a) => typeof a.data === 'string' && a.data.toLowerCase() === HEADER
        );
        if (named) readers.push(`${controller.name}.${method}`);
      }
    }
    return readers.sort();
  };

  /** Every non-spec `.ts` file under `src/`. */
  const sourceFiles = (dir: string = SRC, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) acc.push(full);
    }
    return acc;
  };

  it('derives the controllers from AppModule, and finds the ones it must', async () => {
    const names = (await registeredControllers()).map((c) => c.name);
    // A control: an empty or partial walk would make the route reading below vacuous.
    expect(names).toEqual(
      expect.arrayContaining([
        'AdminStorageController',
        'DevicesController',
        'InvitationsController',
        'MembersController',
        'MessagingController',
        'SecurityController',
      ])
    );
  });

  it('reads the header, in any letter case, in the allowlisted handler and nowhere else', async () => {
    expect(readersOfTheHeader(await registeredControllers())).toEqual([...ALLOWED].sort());
  });

  it('names the header in no source file but the allowlisted one, in any letter case', () => {
    const files = sourceFiles();
    const naming = files
      .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(HEADER))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort();
    // A control: the scan must have read the tree, not an empty directory.
    expect(files.length).toBeGreaterThan(50);
    expect(naming).toEqual([ALLOWED_SOURCE]);
  });

  it("refuses an admin acting on another person's data as it refuses anybody", () => {
    const asAnybody = () => assertCallerOwnsUserId('someone', 'victim', 'refused');
    expect(asAnybody).toThrow(ForbiddenException);
    // The owner check takes no admin flag at all: there is nothing an admin could pass.
    expect(assertCallerOwnsUserId.length).toBe(3);
  });

  /**
   * A controller with NO dependencies: every field it touches throws. A refusal must come from the
   * check at the top of the handler, before anything is read or written - a dependency reached
   * first would fail the case with a different error.
   */
  const bare = <T extends object>(cls: { prototype: T }): T =>
    new Proxy(Object.create(cls.prototype) as T, {
      get(target, key, receiver) {
        if (key in cls.prototype || typeof key === 'symbol') {
          return Reflect.get(target, key, receiver);
        }
        throw new Error(`dependency ${String(key)} reached before the check`);
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

  /**
   * A CHECK CALLED STRICT IS STRICT (review of #2950): a request that names no caller is refused
   * 401, never read as a pass. `HeaderAuthGuard` refuses it first on every route today; these hold
   * the checks to it on their own.
   */
  describe('a request naming no caller is refused 401, never let through', () => {
    it('the owner check', () => {
      expect(() => assertCallerOwnsUserId(undefined, 'victim', 'refused')).toThrow(
        UnauthorizedException
      );
      expect(() => assertCallerOwnsUserId('', 'victim', 'refused')).toThrow(UnauthorizedException);
    });

    const members = bare(MembersController);
    const devices = bare(DevicesController);
    it.each<[string, () => Promise<unknown>]>([
      ['roster read (user-members)', () => members.getGroupUserMembers('g1', undefined)],
      ['roster read (members)', () => members.getGroupMembers('g1', undefined)],
      ['roster removal', () => members.removeGroupMember('g1', 'victim', undefined)],
      ['groups list', () => members.getUserGroups('victim', undefined)],
      [
        'device deletion',
        () => devices.deleteDevice('victim', 'd1', undefined, undefined, undefined),
      ],
    ])('%s', async (_route, call) => {
      await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
