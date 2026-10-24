/// <reference types="jest" />

/**
 * `POST /mls/commit` IS RATE-LIMITED PER USER, AFTER THE GUARD THAT PROVES THE USER.
 *
 * Pinned: the route carries `HeaderAuthGuard` then `UserThrottlerGuard`, in that order (the tracker
 * keys on the `x-user-id` the first guard proved); the limit is `MLS_COMMIT_LIMIT_PER_MINUTE`; the
 * guard lets exactly that many commits through in one window and answers the next with a 429 whose
 * body names `RATE_LIMITED` and the wait (`retryAfterMs`); and
 * one user's quota is not another's. The guard is driven through its real `canActivate` against the
 * real route metadata, so no clock and no sleep decides any of it.
 */
import { ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MLS_COMMIT_LIMIT_PER_MINUTE, MessagingController } from './messaging.controller';

const handler = Object.getOwnPropertyDescriptor(MessagingController.prototype, 'validateCommit')
  ?.value as (...args: unknown[]) => unknown;

/** An HTTP execution context naming the commit route, for the user `userId`. */
function commitContext(userId: string): ExecutionContext {
  const req = { ip: '172.18.0.2', headers: { 'x-user-id': userId } };
  const res = { header: jest.fn(), setHeader: jest.fn() };
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => MessagingController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => null }),
  } as unknown as ExecutionContext;
}

describe('POST /mls/commit rate limit', () => {
  let guard: UserThrottlerGuard;

  beforeEach(async () => {
    // The module default (`app.module.ts`) is 10 per minute: the route must override it, or the
    // default would refuse an ordinary restore's eleventh commit.
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      providers: [UserThrottlerGuard],
    }).compile();
    guard = module.get(UserThrottlerGuard);
    await guard.onModuleInit();
  });

  it('runs the user throttler AFTER the guard that proves the user id', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      HeaderAuthGuard,
      UserThrottlerGuard,
    ]);
  });

  it('accepts exactly the limit in one window, and answers the next commit 429, logged', async () => {
    const warned: string[] = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => void warned.push(args.map(String).join(' ')));
    for (let i = 0; i < MLS_COMMIT_LIMIT_PER_MINUTE; i++) {
      await expect(guard.canActivate(commitContext('user-a'))).resolves.toBe(true);
    }
    expect(warned).toEqual([]);
    const refused = await guard.canActivate(commitContext('user-a')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The wait is carried as a typed field the client reads, not as a header it would have to find.
    const body = (refused as HttpException).getResponse() as { code: string; retryAfterMs: number };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(warned).toEqual([
      expect.stringContaining('[THROTTLE] REFUSED MessagingController.validateCommit'),
    ]);
    jest.restoreAllMocks();
  });

  it("counts per user: one user's burst does not refuse another's commit", async () => {
    for (let i = 0; i < MLS_COMMIT_LIMIT_PER_MINUTE; i++) {
      await guard.canActivate(commitContext('user-a'));
    }
    await expect(guard.canActivate(commitContext('user-b'))).resolves.toBe(true);
  });
});
