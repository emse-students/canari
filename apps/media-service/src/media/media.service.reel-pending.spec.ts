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
 *  - a claim and the sweep cannot interleave into a live post on a deleted object (review of #1744);
 *  - the window cannot be set below an hour;
 *  - the class cannot be put on an existing id through `internal/retention-class`, which would
 *    make a claimed reel sweepable.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaController } from './media.controller';
import {
  MediaService,
  PENDING_REEL_TTL_FLOOR_MS,
  isRetentionClass,
  resolvePendingReelTtlMs,
} from './media.service';

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
  purgeOrphanedChunks: () => Promise<void>;
  sweepIntervalMs: number;
};

/** `deleteGate`, when given, holds every store delete until it resolves - a slow store. */
function serviceWith(
  items: Record<string, Entry>,
  deleteGate?: Promise<void>
): { service: MediaService; deleted: string[]; logs: string[] } {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const logs: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: async (id: string) => {
      if (deleteGate) await deleteGate;
      deleted.push(id);
    },
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: 10, lastModifiedMs: Date.now() }))
      ),
  };
  internals.logger = {
    log: (msg: string) => void logs.push(msg),
    warn: (msg: string) => void logs.push(msg),
  };
  internals.persistMetadata = () => Promise.resolve();
  internals.purgeOrphanedChunks = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted, logs };
}

const purge = (service: MediaService) =>
  (service as unknown as ServiceInternals).purgeExpiredMedia();

const pending = (createdAgoMs: number): Entry => ({
  createdAt: Date.now() - createdAgoMs,
  lastAccessAt: Date.now() - 60_000,
  retentionClass: 'reel-pending',
  ownerId: ALICE,
});

describe('reel-pending: an unclaimed feed reel upload expires', () => {
  it('is a recognised class', () => {
    expect(isRetentionClass('reel-pending')).toBe(true);
  });

  it('sweeps an unclaimed upload older than a day - even one read a minute ago - and keeps a younger one', async () => {
    const items: Record<string, Entry> = {
      [PENDING_OLD]: pending(2 * DAY),
      [PENDING_NEW]: pending(60_000),
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
      [CLAIMED]: pending(60_000),
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
    // A year later, the claimed reel is still not the sweep's.
    items[CLAIMED].createdAt = Date.now() - 400 * DAY;
    items[CLAIMED].lastAccessAt = Date.now() - 400 * DAY;
    await purge(service);

    expect(deleted).toEqual([]);
  });

  it('REFUSES to claim a pending upload already past its window, rather than promoting it', async () => {
    const items: Record<string, Entry> = { [PENDING_OLD]: pending(2 * DAY) };
    const { service } = serviceWith(items);

    const out = await service.claimReels([PENDING_OLD], ALICE);

    expect(out).toEqual({ claimed: [], refused: [PENDING_OLD] });
    expect(items[PENDING_OLD].retentionClass).toBe('reel-pending');
  });

  /**
   * THE RACE OF THE REVIEW (#1744): the sweep judged an entry, awaited the store's delete, then
   * tombstoned it from the stale entry - so a claim landing in that await promoted it, the post was
   * saved, and the object was deleted under the live reel. The tombstone now comes first.
   */
  it('a claim arriving while the sweep is deleting the object meets a tombstone and is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const items: Record<string, Entry> = { [PENDING_OLD]: pending(2 * DAY) };
    const { service, deleted } = serviceWith(items, gate);

    const sweeping = purge(service);
    // The sweep is now inside `await storage.delete`, the window the race used.
    const claim = await service.claimReels([PENDING_OLD], ALICE);
    release();
    await sweeping;

    expect(claim.refused).toEqual([PENDING_OLD]);
    expect(deleted).toEqual([PENDING_OLD]);
    expect(items[PENDING_OLD].purgedAt).toBeDefined();
  });

  it('an entry promoted while the sweep is busy with another, then replaced in the index, is never deleted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const items: Record<string, Entry> = {
      // Reached first: its delete is what holds the run.
      [PENDING_OLD]: pending(2 * DAY),
      // Claimed during that delete, then replaced by a new object (as a download's `setAccess`
      // does) carrying an age that would be due - the run must read the CURRENT entry.
      [CLAIMED]: pending(60_000),
    };
    const { service, deleted } = serviceWith(items, gate);

    const sweeping = purge(service);
    expect((await service.claimReels([CLAIMED], ALICE)).claimed).toEqual([CLAIMED]);
    items[CLAIMED] = { ...items[CLAIMED], createdAt: Date.now() - 3 * DAY };
    release();
    await sweeping;

    expect(deleted).toEqual([PENDING_OLD]);
    expect(items[CLAIMED].purgedAt).toBeUndefined();
    expect(items[CLAIMED].retentionClass).toBe('reel');
  });

  it('logs every deletion with its id, class and age, and the run summary per class', async () => {
    const items: Record<string, Entry> = { [PENDING_OLD]: pending(2 * DAY) };
    const { service, logs } = serviceWith(items);

    await purge(service);

    expect(logs.some((l) => l.includes(PENDING_OLD) && l.includes('class reel-pending'))).toBe(
      true
    );
    expect(logs.some((l) => l.includes('Purged 1') && l.includes('reel-pending 1'))).toBe(true);
  });

  it('reports pending reels and the overdue ones on their own line of the storage stats', async () => {
    const { service } = serviceWith({
      [PENDING_OLD]: pending(2 * DAY),
      [PENDING_NEW]: pending(0),
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

describe('reel-pending: the window has a floor', () => {
  it('defaults to a day when unset or garbled', () => {
    expect(resolvePendingReelTtlMs(undefined)).toBe(DAY);
    expect(resolvePendingReelTtlMs('soon')).toBe(DAY);
  });

  it('honours a value at or over an hour', () => {
    expect(resolvePendingReelTtlMs(String(PENDING_REEL_TTL_FLOOR_MS))).toBe(
      PENDING_REEL_TTL_FLOOR_MS
    );
    expect(resolvePendingReelTtlMs(String(2 * DAY))).toBe(2 * DAY);
  });

  it('refuses to start on a value under the floor - 86400 read as milliseconds is 86 s', () => {
    expect(() => resolvePendingReelTtlMs('86400')).toThrow(/floor/);
    expect(() => resolvePendingReelTtlMs('1')).toThrow(/floor/);
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
    const controller = new MediaController(svc, {} as never, {} as never);

    await expect(
      controller.setRetentionClass(
        { mediaIds: [CLAIMED], retentionClass: 'reel-pending' },
        'internal'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(setRetentionClass).not.toHaveBeenCalled();
  });
});
