/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { LocksController } from './locks.controller';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { ADD_LOCK_TTL_SEC, addLockKey, addLockOwner } from '../utils/add-lock';

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
  take: (c: { locks: LocksController; push: PushController }) => Promise<{ acquired: boolean }>;
  drop: (c: { locks: LocksController; push: PushController }) => Promise<{ released: boolean }>;
}

const DOORS: Door[] = [
  {
    name: 'the JWT door',
    via: 'jwt',
    take: ({ locks }) => locks.acquireAddLock({ groupId: GROUP, deviceId: DEVICE }, USER),
    drop: ({ locks }) => locks.releaseAddLock({ groupId: GROUP, deviceId: DEVICE }, USER),
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
    drop: ({ push }) =>
      push.releaseAddLockPush('PushSecret sekret', {
        userId: USER,
        deviceId: DEVICE,
        groupId: GROUP,
      }),
  },
];

describe('the MLS add-lock - one policy, both doors', () => {
  let locks: LocksController;
  let push: PushController;
  let controllers: { locks: LocksController; push: PushController };

  const redis = { set: jest.fn(), eval: jest.fn() };
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
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    locks = module.get(LocksController);
    push = module.get(PushController);
    controllers = { locks, push };
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: SECRET });
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
  });

  describe.each(DOORS)('$name', ({ take, drop }) => {
    it('takes the one key, for the one lifetime, with the one owner', async () => {
      await take(controllers);

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        addLockKey(GROUP),
        addLockOwner(USER, DEVICE),
        'EX',
        ADD_LOCK_TTL_SEC,
        'NX'
      );
    });

    it('reports the lock taken', async () => {
      await expect(take(controllers)).resolves.toEqual({ acquired: true });
    });

    it('reports the lock refused when another device holds it, and does not pretend otherwise', async () => {
      redis.set.mockResolvedValue(null);

      await expect(take(controllers)).resolves.toEqual({ acquired: false });
    });

    it('releases only under its own ownership check', async () => {
      await drop(controllers);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keyCount, key, owner] = redis.eval.mock.calls[0];
      expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
      expect(script).toContain("redis.call('del', KEYS[1])");
      expect(keyCount).toBe(1);
      expect(key).toBe(addLockKey(GROUP));
      expect(owner).toBe(addLockOwner(USER, DEVICE));
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
});
