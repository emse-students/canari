/// <reference types="jest" />

/**
 * THE KEY-GROUP PUSH ROUTES ARE RATE-LIMITED PER USER, AFTER THE GUARD THAT PROVES THE USER.
 *
 * Every other commit path counts per account; a shut phone's external commit into a key group
 * (channel-encryption section 26) must too. Pinned: both routes carry `PushSecretGuard` then
 * `PushSecretThrottlerGuard`, in that order; the limit is `KEY_GROUP_PUSH_LIMIT_PER_MINUTE`; the
 * guard lets exactly that many through in one window and answers the next with a 429; one user's
 * quota is not another's; and a request whose PushSecret fails is refused before it is counted.
 * The guards run through their real `canActivate` against the real route metadata - no clock.
 */
import { ExecutionContext, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { PushToken } from '../entities/push-token.entity';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { KEY_GROUP_PUSH_LIMIT_PER_MINUTE, PushController } from './push.controller';

const route = (name: string) =>
  Object.getOwnPropertyDescriptor(PushController.prototype, name)?.value as (
    ...args: unknown[]
  ) => unknown;

// sha256('sekret')
const STORED = 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412';

function context(handler: (...args: unknown[]) => unknown, userId: string, secret = 'sekret') {
  const req = {
    ip: '172.18.0.2',
    headers: { authorization: `PushSecret ${secret}` },
    body: { userId, deviceId: 'dev-1', groupId: 'kg-1' },
  };
  const res = { header: jest.fn(), setHeader: jest.fn() };
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => PushController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => null }),
  } as unknown as ExecutionContext;
}

describe('key-group push routes rate limit', () => {
  let secretGuard: PushSecretGuard;
  let throttler: PushSecretThrottlerGuard;
  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };

  /** Both guards, in the route's order - as Nest runs them. */
  const pass = async (ctx: ExecutionContext) =>
    (await secretGuard.canActivate(ctx)) && (await throttler.canActivate(ctx));

  beforeEach(async () => {
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: STORED });
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      providers: [
        PushSecretGuard,
        PushSecretThrottlerGuard,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
      ],
    }).compile();
    secretGuard = module.get(PushSecretGuard);
    throttler = module.get(PushSecretThrottlerGuard);
    await throttler.onModuleInit();
  });

  it.each(['getKeyGroupBasePush', 'submitKeyGroupJoinPush'])(
    '%s runs the user throttler AFTER the guard that proves the PushSecret',
    (name) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, route(name))).toEqual([
        PushSecretGuard,
        PushSecretThrottlerGuard,
      ]);
    }
  );

  it('accepts exactly the limit in one window, and answers the next join 429', async () => {
    const handler = route('submitKeyGroupJoinPush');
    // Above the module default of 10: the route's own limit is what applies.
    expect(KEY_GROUP_PUSH_LIMIT_PER_MINUTE).toBeGreaterThan(10);
    for (let i = 0; i < KEY_GROUP_PUSH_LIMIT_PER_MINUTE; i++) {
      await expect(pass(context(handler, 'user-a'))).resolves.toBe(true);
    }
    const refused = await pass(context(handler, 'user-a')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("counts per user: one user's burst does not refuse another's join", async () => {
    const handler = route('submitKeyGroupJoinPush');
    for (let i = 0; i < KEY_GROUP_PUSH_LIMIT_PER_MINUTE; i++) {
      await pass(context(handler, 'user-a'));
    }
    await expect(pass(context(handler, 'user-b'))).resolves.toBe(true);
  });

  it("a wrong PushSecret is refused before it is counted, so nobody can spend another's quota", async () => {
    const handler = route('submitKeyGroupJoinPush');
    for (let i = 0; i < KEY_GROUP_PUSH_LIMIT_PER_MINUTE + 5; i++) {
      await expect(pass(context(handler, 'user-a', 'wrong'))).rejects.toBeInstanceOf(
        ForbiddenException
      );
    }
    await expect(pass(context(handler, 'user-a'))).resolves.toBe(true);
  });
});
