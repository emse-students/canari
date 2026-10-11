/// <reference types="jest" />

/**
 * The `reel-pending` class: a FEED reel's upload before its post exists (reels audit, 2026-10-11).
 *
 * A publish that fails, is killed or is cancelled after its upload used to leave a blob of class
 * `reel` that no post cited and nothing reaped - 14-35 MB for ever. The client now uploads
 * `reel-pending`, the claim at `createPost` promotes it to `reel`, and the sweep takes an unclaimed
 * one by AGE. What is pinned is the destructive edge, both ways:
 *  - an unclaimed pending reel older than the TTL is deleted, and one younger is not;
 *  - a CLAIMED reel is `reel` and is never deleted, however old - including every reel stored
 *    before this class existed;
 *  - the class cannot be put on an existing id through `internal/retention-class`, which would
 *    make a claimed reel sweepable.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService, isRetentionClass } from './media.service';

const ALICE = 'alice';
const PENDING_OLD = '11111111-1111-4111-8111-111111111111';
const PENDING_NEW = '22222222-2222-4222-8222-222222222222';
const CLAIMED = '33333333-3333-4333-8333-333333333333';
const LEGACY_REEL = '44444444-4444-4444-8444-444444444444';

const DAY = 24 * 60 * 60 * 1000;

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
  retentionClass?: string;
  ownerId?: string;
};

type ServiceInternals = {
  meta: { items: Record<string, Entry> };
  storage: {
    delete: (id: string) => Promise<void>;
    listObjects: () => Promise<Array<{ id: string; size: number; lastModifiedMs: number | null }>>;
  };
  logger: { log: (msg: string) => void; warn: (msg: string) => void };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
};

function serviceWith(items: Record<string, Entry>): { service: MediaService; deleted: string[] } {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: 10, lastModifiedMs: Date.now() }))
      ),
  };
  internals.logger = { log: () => {}, warn: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted };
}

const purge = (service: MediaService) =>
  (service as unknown as ServiceInternals).purgeExpiredMedia();

describe('reel-pending: an unclaimed feed reel upload expires', () => {
  it('is a recognised class', () => {
    expect(isRetentionClass('reel-pending')).toBe(true);
  });

  it('sweeps an unclaimed upload older than a day - even one read a minute ago - and keeps a younger one', async () => {
    const items: Record<string, Entry> = {
      [PENDING_OLD]: {
        createdAt: Date.now() - 2 * DAY,
        lastAccessAt: Date.now() - 60_000,
        retentionClass: 'reel-pending',
        ownerId: ALICE,
      },
      [PENDING_NEW]: {
        createdAt: Date.now() - 60_000,
        lastAccessAt: Date.now() - 60_000,
        retentionClass: 'reel-pending',
        ownerId: ALICE,
      },
    };
    const { service, deleted } = serviceWith(items);

    await purge(service);

    expect(deleted).toEqual([PENDING_OLD]);
    expect(items[PENDING_OLD].purgedAt).toBeDefined();
    expect(items[PENDING_OLD].purgeReason).toBe('retention_expired');
    expect(items[PENDING_NEW].purgedAt).toBeUndefined();
  });

  it('is promoted to `reel` by the claim, and a claimed reel is NEVER swept, however old', async () => {
    const items: Record<string, Entry> = {
      [CLAIMED]: {
        createdAt: Date.now() - 400 * DAY,
        lastAccessAt: Date.now() - 400 * DAY,
        retentionClass: 'reel-pending',
        ownerId: ALICE,
      },
      // Stored before this class existed: uploaded as `reel` and kept until its post's purge.
      [LEGACY_REEL]: {
        createdAt: Date.now() - 400 * DAY,
        lastAccessAt: Date.now() - 400 * DAY,
        retentionClass: 'reel',
        ownerId: ALICE,
      },
    };
    const { service, deleted } = serviceWith(items);

    expect((await service.claimReels([CLAIMED], ALICE)).claimed).toEqual([CLAIMED]);
    expect(items[CLAIMED].retentionClass).toBe('reel');
    await purge(service);

    expect(deleted).toEqual([]);
  });

  it('reports pending reels and the overdue ones on their own line of the storage stats', async () => {
    const { service } = serviceWith({
      [PENDING_OLD]: {
        createdAt: Date.now() - 2 * DAY,
        lastAccessAt: Date.now(),
        retentionClass: 'reel-pending',
        ownerId: ALICE,
      },
      [PENDING_NEW]: {
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        retentionClass: 'reel-pending',
        ownerId: ALICE,
      },
    });

    const stats = await service.getStorageStats();

    expect(stats.pendingReelCount).toBe(2);
    expect(stats.pendingReelBytes).toBe(20);
    expect(stats.pendingReelOverdueCount).toBe(1);
    expect(stats.pendingReelOverdueBytes).toBe(10);
    expect(stats.pendingReelTtlMs).toBe(DAY);
    // Never folded into the idle sweep's overdue figure, which reads `lastAccessAt`.
    expect(stats.overdueCount).toBe(0);
    expect(stats.unclassifiedCount).toBe(0);
  });
});

describe('reel-pending: never applied to an existing id', () => {
  const prev = process.env.INTERNAL_SECRET;
  beforeAll(() => {
    process.env.INTERNAL_SECRET = 'internal';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = prev;
  });

  it('is refused by internal/retention-class, so a claimed reel cannot be made sweepable', async () => {
    const svc = Object.create(MediaService.prototype) as MediaService;
    const setRetentionClass = jest.spyOn(svc, 'setRetentionClass');
    const controller = new MediaController(svc, {} as never);

    await expect(
      controller.setRetentionClass(
        { mediaIds: [CLAIMED], retentionClass: 'reel-pending' },
        'internal'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(setRetentionClass).not.toHaveBeenCalled();
  });
});
