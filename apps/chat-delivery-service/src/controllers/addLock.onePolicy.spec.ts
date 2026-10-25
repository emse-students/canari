/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { LocksController } from './locks.controller';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import {
  ADD_LOCK_TTL_SEC,
  addLockKey,
  addLockOwner,
  addLockValue,
  releaseAddLock,
} from '../utils/add-lock';

/**
 * ONE LOCK, TWO DOORS, AND THEY DISAGREED ABOUT HOW LONG IT LIVES.
 *
 * `POST/DELETE mls/add-lock` is the JWT-guarded door; `POST mls/push/acquire-add-lock` and its
 * `DELETE` twin are the PushSecret door for the Android background service, which cannot mint a
 * JWT. Both wrote the SAME Redis key with the SAME owner - and for different times:
 *
 * | | the JWT door | the PushSecret door |
 * | --- | --- | --- |
 * | lifetime | `ttlMs` from the body, clamped 1-60 s (every caller sent 30 s) | hard-coded **15 s** |
 * | the log line | `[ADD_LOCK] ... ttl=30s` | `[ADD_LOCK_PUSH] ...`, no TTL at all |
 *
 * The shorter one was on the SLOWER path. The 30 s was sized on the mobile worst case - bulk add +
 * state persist + validated commit + the Welcome loop - after 10 s expired mid-operation and forked
 * the epoch (H1); the background service runs exactly that work, and took the lock for half the
 * time. A lock that expires under its holder is not a lock, and the second device that then takes
 * it commits into the same epoch.
 *
 * This file drives BOTH doors over ONE table. Asserting on `utils/add-lock.ts` alone would prove
 * nothing about a door that keeps its own `redis.set` - which is precisely how these two came
 * apart.
 */

// sha256('sekret'), the stored form `verifyPushSecretAuth` hashes the header against.
const SECRET = 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412';

const USER = 'u1';
const DEVICE = 'd1';
const GROUP = 'g1';

/** The two doors, as the test drives them. Everything else about a row is identical by construction. */
interface Door {
  name: string;
  via: 'jwt' | 'push';
  take: (c: {
    locks: LocksController;
    push: PushController;
  }) => Promise<{ acquired: boolean; token?: string; retryAfterMs?: number }>;
  drop: (
    c: { locks: LocksController; push: PushController },
    token?: string
  ) => Promise<{ released: boolean }>;
}

const DOORS: Door[] = [
  {
    name: 'the JWT door',
    via: 'jwt',
    take: ({ locks }) => locks.acquireAddLock({ groupId: GROUP, deviceId: DEVICE }, USER),
    drop: ({ locks }, token) =>
      locks.releaseAddLock({ groupId: GROUP, deviceId: DEVICE, ...(token ? { token } : {}) }, USER),
  },
  {
    name: 'the PushSecret door',
    via: 'push',
    take: ({ push }) =>
      push.acquireAddLockPush('PushSecret sekret', {
        userId: USER,
        deviceId: DEVICE,
        groupId: GROUP,
      }),
    drop: ({ push }, token) =>
      push.releaseAddLockPush('PushSecret sekret', {
        userId: USER,
        deviceId: DEVICE,
        groupId: GROUP,
        ...(token ? { token } : {}),
      }),
  },
];

describe('the MLS add-lock - one policy, both doors', () => {
  let locks: LocksController;
  let push: PushController;
  let controllers: { locks: LocksController; push: PushController };

  const redis = { set: jest.fn(), eval: jest.fn(), pttl: jest.fn() };
  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocksController, PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: {} as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    locks = module.get(LocksController);
    push = module.get(PushController);
    controllers = { locks, push };
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: SECRET });
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    redis.pttl.mockResolvedValue(12_345);
  });

  describe.each(DOORS)('$name', ({ take, drop }) => {
    it('takes the one key, for the one lifetime, with the one owner and a token of its own', async () => {
      const taken = await take(controllers);

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(taken.acquired).toBe(true);
      expect(taken.token).toEqual(expect.any(String));
      expect(redis.set).toHaveBeenCalledWith(
        addLockKey(GROUP),
        addLockValue(addLockOwner(USER, DEVICE), taken.token as string),
        'EX',
        ADD_LOCK_TTL_SEC,
        'NX'
      );
    });

    it('mints a different token for every acquisition', async () => {
      const a = await take(controllers);
      const b = await take(controllers);
      expect(a.token).not.toBe(b.token);
    });

    it("reports the lock refused - with the holder's remaining lifetime, the server's own fact", async () => {
      redis.set.mockResolvedValue(null);

      await expect(take(controllers)).resolves.toEqual({ acquired: false, retryAfterMs: 12_345 });
      expect(redis.pttl).toHaveBeenCalledWith(addLockKey(GROUP));
    });

    it('a refusal whose key vanished meanwhile says 0 ms, never a negative', async () => {
      redis.set.mockResolvedValue(null);
      redis.pttl.mockResolvedValue(-2);

      await expect(take(controllers)).resolves.toEqual({ acquired: false, retryAfterMs: 0 });
    });

    it('a release WITH its token deletes exactly that acquisition', async () => {
      await drop(controllers, 'tok-1');

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keyCount, key, value, ...rest] = redis.eval.mock.calls[0];
      expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
      expect(script).toContain("redis.call('del', KEYS[1])");
      expect(keyCount).toBe(1);
      expect(key).toBe(addLockKey(GROUP));
      expect(value).toBe(addLockValue(addLockOwner(USER, DEVICE), 'tok-1'));
      expect(rest).toEqual([]);
    });

    it('a release with NO token takes the legacy owner-only path', async () => {
      await drop(controllers);

      const [script, , key, owner, prefix] = redis.eval.mock.calls[0];
      expect(script).toContain('string.sub');
      expect(key).toBe(addLockKey(GROUP));
      expect(owner).toBe(addLockOwner(USER, DEVICE));
      expect(prefix).toBe(addLockOwner(USER, DEVICE) + '#');
    });

    it('reports a release it did not perform as not released', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(drop(controllers)).resolves.toEqual({ released: false });
    });
  });

  it('the lifetime is long enough to cover the work the lock is held across', () => {
    // 10 s expired mid-operation and forked the epoch (H1). The number may be re-measured; it may
    // not quietly go back under the path it exists to cover.
    expect(ADD_LOCK_TTL_SEC).toBeGreaterThanOrEqual(30);
  });

  it('is driving two doors, and not one of them twice', () => {
    // The self-check: a table that resolved both rows to the same handler would assert nothing
    // about the divergence this file exists for.
    expect(DOORS).toHaveLength(2);
    expect(locks).toBeInstanceOf(LocksController);
    expect(push).toBeInstanceOf(PushController);
  });

  /**
   * What each release DELETES, against a model of the key: the two scripts are told apart by their
   * arguments (a token value alone, or the owner and its prefix), so the model applies the rule each
   * script states.
   */
  describe('what each release deletes', () => {
    const OWNER = addLockOwner(USER, DEVICE);
    const logger = { log: jest.fn() } as never;
    let held: string | null;
    const store = {
      eval: jest.fn(async (_script: string, _n: number, _key: string, a1: string, a2?: string) => {
        const legacy = a2 !== undefined;
        const match = legacy ? held === a1 || (held?.startsWith(a2) ?? false) : held === a1;
        if (!match) return 0;
        held = null;
        return 1;
      }),
    } as never;
    const holder = { groupId: GROUP, userId: USER, deviceId: DEVICE };

    it('a WRONG token frees nothing - a late release never deletes a live acquisition of its own device', async () => {
      held = addLockValue(OWNER, 'live');
      await expect(releaseAddLock(store, logger, holder, 'jwt', 'stale')).resolves.toBe(false);
      expect(held).toBe(addLockValue(OWNER, 'live'));
    });

    it('the right token frees its acquisition', async () => {
      held = addLockValue(OWNER, 'live');
      await expect(releaseAddLock(store, logger, holder, 'jwt', 'live')).resolves.toBe(true);
      expect(held).toBeNull();
    });

    it('a LEGACY client (no token) still releases a token lock of its own device, and a bare owner', async () => {
      held = addLockValue(OWNER, 'live');
      await expect(releaseAddLock(store, logger, holder, 'jwt')).resolves.toBe(true);
      held = OWNER;
      await expect(releaseAddLock(store, logger, holder, 'jwt')).resolves.toBe(true);
    });

    it('the legacy release never frees ANOTHER device lock', async () => {
      held = addLockValue(addLockOwner(USER, 'd2'), 'theirs');
      await expect(releaseAddLock(store, logger, holder, 'jwt')).resolves.toBe(false);
    });
  });
});
