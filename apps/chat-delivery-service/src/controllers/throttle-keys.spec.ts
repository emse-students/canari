/// <reference types="jest" />

import 'reflect-metadata';
import { ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
import { PUSH_SECRET_USER, PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { PushController } from './push.controller';
import { MessagingController } from './messaging.controller';

/**
 * NO ROUTE OF THIS SERVICE IS COUNTED ON THE STOCK `ThrottlerGuard` (weak-network audit, 2026-11-10).
 *
 * The stock guard keys on `req.ip`, and every request reaches this service through the nginx
 * container, so its quota (10 a minute, `app.module.ts`) is ONE bucket shared by the whole estate:
 * `POST /mls/push/register` sat on it, and a few phones starting in the same minute were enough to
 * answer the next ones `429` (three in five seconds at a cold start, in the owner's 1.6.9 log).
 * Each throttler counts on a key a guard BEFORE it proved: a session route per user
 * (`HeaderAuthGuard`, then `UserThrottlerGuard`), a shut phone's route per user
 * (`PushSecretGuard`, then `PushSecretThrottlerGuard`), and only a route that proves nobody per
 * visitor address (`ClientIpThrottlerGuard`). Every one of them refuses with a `[THROTTLE]` line.
 */

type Guard = abstract new (...args: never[]) => unknown;
type Controller = { name: string; prototype: object };

/** The guard each throttler must follow: the one that proves the key it counts on. */
const PROVER: ReadonlyMap<Guard, Guard | null> = new Map<Guard, Guard | null>([
  [UserThrottlerGuard, HeaderAuthGuard],
  [PushSecretThrottlerGuard, PushSecretGuard],
  [ClientIpThrottlerGuard, null],
]);

function guardsOf(controller: { prototype: object }, method: string): unknown[] {
  const handler = Object.getOwnPropertyDescriptor(controller.prototype, method)?.value as object;
  expect(handler).toBeDefined();
  return (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
}

/** Every controller the service actually mounts - read from `AppModule`, never listed by hand. */
let controllers: Controller[] = [];

const postgresUrl = process.env.POSTGRES_URL;
afterAll(() => {
  if (postgresUrl === undefined) delete process.env.POSTGRES_URL;
  else process.env.POSTGRES_URL = postgresUrl;
});

beforeAll(async () => {
  // `AppModule` builds its TypeORM options when the file loads and refuses without a database URL;
  // nothing here connects, the module's metadata is all that is read.
  process.env.POSTGRES_URL ??= 'postgres://unused@localhost/unused';
  const { AppModule } = await import('../app.module');
  controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? []) as Controller[];
});

/** Every route handler of every mounted controller, with its guards (class-level ones first). */
function everyHandler(): { route: string; guards: unknown[] }[] {
  const out: { route: string; guards: unknown[] }[] = [];
  for (const controller of controllers) {
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === 'constructor') continue;
      const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value;
      if (typeof handler !== 'function') continue;
      const own = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
      out.push({ route: `${controller.name}.${name}`, guards: [...classGuards, ...own] });
    }
  }
  return out;
}

describe('throttle keys', () => {
  it('reads the mounted controllers from AppModule', () => {
    expect(controllers.length).toBeGreaterThan(10);
    expect(controllers).toEqual(expect.arrayContaining([PushController, MessagingController]));
  });

  it('no handler of any mounted controller names the stock guard', () => {
    const offenders = everyHandler()
      .filter((h) => h.guards.includes(ThrottlerGuard))
      .map((h) => h.route);
    expect(offenders).toEqual([]);
  });

  it('every throttler runs right after the guard that proves its key', () => {
    const offenders: string[] = [];
    for (const { route, guards } of everyHandler()) {
      guards.forEach((guard, i) => {
        if (!PROVER.has(guard as Guard)) return;
        const prover = PROVER.get(guard as Guard);
        if (prover !== null && guards[i - 1] !== prover) offenders.push(route);
      });
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    [PushController, 'registerPushToken'],
    [PushController, 'reportPushUnavailable'],
    [MessagingController, 'reportSenderMismatch'],
    [MessagingController, 'reportUninvitedEntry'],
    [MessagingController, 'reportIntegrityFinding'],
  ] as const)('%p.%s counts per proven user, after the session guard', (controller, method) => {
    expect(guardsOf(controller, method)).toEqual([HeaderAuthGuard, UserThrottlerGuard]);
  });

  it.each([
    [PushController, 'reportBlindBanner'],
    [PushController, 'markChannelReadForPush'],
  ] as const)(
    '%p.%s (a shut phone) counts per user, after the push secret is proven',
    (controller, method) => {
      expect(guardsOf(controller, method)).toEqual([PushSecretGuard, PushSecretThrottlerGuard]);
    }
  );
});

describe('every throttler guard refuses out loud', () => {
  const handler = Object.getOwnPropertyDescriptor(PushController.prototype, 'reportBlindBanner')
    ?.value as () => unknown;

  /** An HTTP context on one route, with a request already carrying each guard's key. */
  function context(): ExecutionContext {
    const req = {
      ip: '172.18.0.2',
      headers: { 'x-user-id': 'user-a', 'x-real-ip': '198.51.100.7' },
      [PUSH_SECRET_USER]: 'user-a',
    };
    const res = { header: jest.fn(), setHeader: jest.fn() };
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => PushController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => null }),
    } as unknown as ExecutionContext;
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([UserThrottlerGuard, PushSecretThrottlerGuard, ClientIpThrottlerGuard])(
    '%p answers a coded 429 and leaves a [THROTTLE] REFUSED line',
    async (Guard) => {
      const module = await Test.createTestingModule({
        imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
        providers: [Guard],
      }).compile();
      const guard = module.get<ThrottlerGuard>(Guard);
      await guard.onModuleInit();
      const warned: string[] = [];
      jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((...args: unknown[]) => void warned.push(args.map(String).join(' ')));
      await expect(guard.canActivate(context())).resolves.toBe(true);
      await expect(guard.canActivate(context())).resolves.toBe(true);
      expect(warned).toEqual([]);
      const refused = await guard.canActivate(context()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(((refused as HttpException).getResponse() as { code: string }).code).toBe(
        'RATE_LIMITED'
      );
      expect(warned).toEqual([
        expect.stringContaining('[THROTTLE] REFUSED PushController.reportBlindBanner'),
      ]);
    }
  );
});
