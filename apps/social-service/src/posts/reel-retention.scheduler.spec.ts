/**
 * `ReelRetentionScheduler` - the worker that deletes a CanaReel and EVERYTHING that hangs off it.
 *
 * What these cases are built to catch, in the order a regression would hurt:
 *  - a non-reel post being reached by a code path that deletes things (the row delete names
 *    `kind = 'reel'` in its own WHERE; the fake below evaluates that clause, so dropping it fails
 *    the first case instead of passing for lack of a reel to protect);
 *  - the row going BEFORE its blobs, or going while a blob is still there - the row is the only
 *    record of which blob to delete, so a stranded blob is a leak nothing can ever reap;
 *  - one reel the store refuses stopping the batch, or spinning the loop;
 *  - a second run doing anything: idempotence comes from the row, never from a clock.
 *
 * The store is an in-memory fake with the media service's vocabulary (`deleted` / `absent` /
 * `refused` / `failed`) and its ownership allowlist, so "a comment that merely CITES somebody
 * else's blob does not get it deleted" is asserted against behaviour, not against a stub's say-so.
 * The SQL itself is exercised against a real PostgreSQL by `reel-retention.integration.spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { ReelRetentionScheduler } from './reel-retention.scheduler';
import type { ReelPurgeOutcome } from '../internal/reel-media';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const PAST = new Date(NOW - 60_000);
const FUTURE = new Date(NOW + 60_000);

interface Row {
  id: string;
  authorId: string;
  kind: 'post' | 'reel';
  expiresAt: Date | null;
  images: Array<{ mediaId: string }>;
  comments: Array<{ id: string; userId: string; media?: { mediaId: string } }>;
}

interface Notification {
  id: string;
  postId: string;
}

/** A tiny database that understands exactly the four statements the worker issues. */
function makeWorld(initial: { posts: Row[]; blobs: Record<string, string>; failing?: string[] }) {
  const posts = [...initial.posts];
  let notifications: Notification[] = [];
  const blobs = new Map(Object.entries(initial.blobs)); // mediaId -> ownerId
  const failing = new Set(initial.failing ?? []);
  const sql: string[] = [];
  const purgeCalls: Array<Array<{ mediaId: string; ownerId: string }>> = [];
  let failTransactionOnce = false;
  let mediaDown = false;

  const manager = {
    query: jest.fn((statement: string, params: unknown[] = []) => {
      sql.push(statement.replace(/\s+/g, ' ').trim());
      if (/^SELECT id, "authorId", images, comments/i.test(statement.trim())) {
        const kept = params[0] as string[];
        const limit = params[1] as number;
        // The worker's predicate, evaluated as written: a reel, due, not already kept for retry.
        return Promise.resolve(
          posts
            .filter(
              (p) =>
                p.kind === 'reel' &&
                p.expiresAt !== null &&
                p.expiresAt.getTime() <= NOW &&
                !kept.includes(p.id)
            )
            .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
            .slice(0, limit)
            .map(({ id, authorId, images, comments }) => ({ id, authorId, images, comments }))
        );
      }
      if (/^DELETE FROM post_notifications/i.test(statement.trim())) {
        notifications = notifications.filter((n) => n.postId !== params[0]);
        return Promise.resolve([[], 0]);
      }
      if (/^DELETE FROM posts WHERE id = \$1 AND kind = 'reel'/i.test(statement.trim())) {
        // The clause the allowlist lives in: evaluated, not assumed.
        const i = posts.findIndex(
          (p) =>
            p.id === params[0] &&
            p.kind === 'reel' &&
            p.expiresAt !== null &&
            p.expiresAt.getTime() <= NOW
        );
        if (i >= 0) posts.splice(i, 1);
        return Promise.resolve([[], i >= 0 ? 1 : 0]);
      }
      return Promise.reject(new Error(`unexpected statement: ${statement}`));
    }),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = { posts: [...posts], notifications: [...notifications] };
      try {
        if (failTransactionOnce) {
          failTransactionOnce = false;
          throw new Error('connection reset during commit');
        }
        return await fn(manager);
      } catch (e) {
        posts.splice(0, posts.length, ...snapshot.posts);
        notifications = snapshot.notifications;
        throw e;
      }
    }),
  };

  /** The media service's behaviour: ownership is the allowlist, `absent` is success. */
  const retention = {
    purgeReelBlobs: jest.fn((items: Array<{ mediaId: string; ownerId: string }>) => {
      purgeCalls.push(items);
      if (mediaDown) return Promise.reject(new Error('connect ECONNREFUSED media-service'));
      const out: Record<string, ReelPurgeOutcome> = {};
      for (const { mediaId, ownerId } of items) {
        if (failing.has(mediaId)) out[mediaId] = 'failed';
        else if (!blobs.has(mediaId)) out[mediaId] = 'absent';
        else if (blobs.get(mediaId) !== ownerId) out[mediaId] = 'refused';
        else {
          blobs.delete(mediaId);
          out[mediaId] = 'deleted';
        }
      }
      return Promise.resolve(out);
    }),
  };

  const redis = { deleteByPattern: jest.fn(() => Promise.resolve(0)) };
  const scheduler = new ReelRetentionScheduler(
    { manager } as never,
    retention as never,
    redis as never
  );

  return {
    scheduler,
    redis,
    posts,
    blobs,
    failing,
    sql,
    purgeCalls,
    retention,
    notify: (n: Notification) => notifications.push(n),
    notifications: () => notifications,
    failTransactionOnce: () => {
      failTransactionOnce = true;
    },
    setMediaDown: (down: boolean) => {
      mediaDown = down;
    },
  };
}

const reel = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  authorId: 'alice',
  kind: 'reel',
  expiresAt: PAST,
  images: [{ mediaId: `blob-${id}` }],
  comments: [],
  ...overrides,
});

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ReelRetentionScheduler - the cascade', () => {
  it('deletes the post, its comments, its notifications AND every blob, comment media included', async () => {
    const world = makeWorld({
      posts: [
        reel('r1', {
          comments: [
            { id: 'c1', userId: 'bob', media: { mediaId: 'comment-media' } },
            { id: 'c2', userId: 'carol' },
          ],
        }),
      ],
      blobs: { 'blob-r1': 'alice', 'comment-media': 'bob' },
    });
    world.notify({ id: 'n1', postId: 'r1' });
    world.notify({ id: 'n2', postId: 'someone-elses' });

    const report = await world.scheduler.purgeOnce();

    expect(report).toMatchObject({ due: 1, deleted: 1, failed: 0 });
    expect(world.posts).toHaveLength(0);
    expect([...world.blobs.keys()]).toEqual([]);
    // The notification that pointed at the dead reel goes; an unrelated one stays.
    expect(world.notifications()).toEqual([{ id: 'n2', postId: 'someone-elses' }]);
    // Each blob was named under ITS OWN uploader - the reel's under the author, the comment's under
    // the commenter - which is the media service's allowlist.
    expect(world.purgeCalls[0]).toEqual([
      { mediaId: 'blob-r1', ownerId: 'alice' },
      { mediaId: 'comment-media', ownerId: 'bob' },
    ]);
  });

  it('deletes the blobs BEFORE the row, and keeps the row when a blob is still there', async () => {
    const world = makeWorld({
      posts: [reel('r1')],
      blobs: { 'blob-r1': 'alice' },
      failing: ['blob-r1'],
    });

    const report = await world.scheduler.purgeOnce();

    expect(report).toMatchObject({ due: 1, deleted: 0, failed: 1 });
    expect(world.posts.map((p) => p.id)).toEqual(['r1']);
    expect(world.blobs.has('blob-r1')).toBe(true);
    // The accusation names the reel and the blob, so the line alone says what to look at.
    expect(warn.mock.calls.flat().join(' ')).toContain('reel=r1 kept');
    expect(warn.mock.calls.flat().join(' ')).toContain('blob-r1');
  });

  it("leaves a blob that is NOT the uploader's alone, and still removes the reel that cited it", async () => {
    const world = makeWorld({
      posts: [
        reel('r1', {
          comments: [{ id: 'c1', userId: 'mallory', media: { mediaId: 'bobs-chat' } }],
        }),
      ],
      // Mallory's comment cites a blob that Bob uploaded.
      blobs: { 'blob-r1': 'alice', 'bobs-chat': 'bob' },
    });

    const report = await world.scheduler.purgeOnce();

    expect(report.deleted).toBe(1);
    expect(report.blobs.refused).toBe(1);
    expect(world.blobs.has('bobs-chat')).toBe(true);
    expect(world.blobs.has('blob-r1')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toContain('not its uploader');
  });
});

describe('ReelRetentionScheduler - a non-reel post is never touched', () => {
  it('ignores posts and unexpired reels, whatever their columns say', async () => {
    const world = makeWorld({
      posts: [
        // An ordinary post, and one carrying a stale expiry it could never have in the database
        // (the CHECK forbids it) - the worker must still not select it, nor delete it.
        { ...reel('p1', { kind: 'post', expiresAt: null }) },
        { ...reel('p2', { kind: 'post', expiresAt: PAST }) },
        reel('live', { expiresAt: FUTURE }),
        reel('due'),
      ],
      blobs: { 'blob-p1': 'alice', 'blob-p2': 'alice', 'blob-live': 'alice', 'blob-due': 'alice' },
    });

    const report = await world.scheduler.purgeOnce();

    expect(report.due).toBe(1);
    expect(world.posts.map((p) => p.id).sort()).toEqual(['live', 'p1', 'p2']);
    expect([...world.blobs.keys()].sort()).toEqual(['blob-live', 'blob-p1', 'blob-p2']);
    // Not one blob of a non-reel was even NAMED to the media service.
    expect(world.purgeCalls.flat().map((i) => i.mediaId)).toEqual(['blob-due']);
  });

  it('cannot delete a non-reel even if its id is handed to the row delete', async () => {
    const world = makeWorld({
      posts: [{ ...reel('p2', { kind: 'post', expiresAt: PAST }) }],
      blobs: {},
    });
    // Drives the private step directly: the clause, not the selection, is what is under test.
    await (
      world.scheduler as unknown as {
        purgeReel: (row: unknown, report: unknown) => Promise<boolean>;
      }
    ).purgeReel(
      { id: 'p2', authorId: 'alice', images: [], comments: [] },
      { blobs: { deleted: 0, absent: 0, refused: 0, failed: 0 } }
    );
    expect(world.posts.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('ReelRetentionScheduler - idempotence from the row, never from a clock', () => {
  it('a second run finds nothing and does nothing', async () => {
    const world = makeWorld({
      posts: [reel('r1'), reel('r2')],
      blobs: { 'blob-r1': 'alice', 'blob-r2': 'alice' },
    });

    const first = await world.scheduler.purgeOnce();
    const callsAfterFirst = world.purgeCalls.length;
    const second = await world.scheduler.purgeOnce();

    expect(first.deleted).toBe(2);
    expect(second).toMatchObject({ due: 0, deleted: 0, failed: 0 });
    expect(world.purgeCalls.length).toBe(callsAfterFirst);
    // The feed cache is dropped once for the run that deleted, and not again by the run that did not.
    expect(world.redis.deleteByPattern).toHaveBeenCalledTimes(1);
  });

  it('recovers from a crash between the blobs and the row: the retry sees them absent and finishes', async () => {
    const world = makeWorld({ posts: [reel('r1')], blobs: { 'blob-r1': 'alice' } });
    world.failTransactionOnce();

    const crashed = await world.scheduler.purgeOnce();
    expect(crashed).toMatchObject({ due: 1, deleted: 0, failed: 1 });
    // The blob went, the row stayed - the state a crash leaves.
    expect(world.blobs.has('blob-r1')).toBe(false);
    expect(world.posts).toHaveLength(1);

    const retry = await world.scheduler.purgeOnce();
    expect(retry).toMatchObject({ due: 1, deleted: 1, failed: 0 });
    expect(retry.blobs.absent).toBe(1);
    expect(world.posts).toHaveLength(0);
  });
});

describe("ReelRetentionScheduler - one failure is that reel's alone", () => {
  it('deletes every other reel when one blob refuses, and finishes it on a later run', async () => {
    const world = makeWorld({
      posts: [
        reel('r1', { expiresAt: new Date(NOW - 3000) }),
        reel('r2', { expiresAt: new Date(NOW - 2000) }),
        reel('r3', { expiresAt: new Date(NOW - 1000) }),
      ],
      blobs: { 'blob-r1': 'alice', 'blob-r2': 'alice', 'blob-r3': 'alice' },
      failing: ['blob-r2'],
    });

    const report = await world.scheduler.purgeOnce();

    expect(report).toMatchObject({ due: 3, deleted: 2, failed: 1 });
    expect(world.posts.map((p) => p.id)).toEqual(['r2']);
    expect(world.blobs.has('blob-r1')).toBe(false);
    expect(world.blobs.has('blob-r3')).toBe(false);

    // The store recovers; the stuck reel goes on the next run, and nothing else is touched.
    world.failing.clear();
    const later = await world.scheduler.purgeOnce();
    expect(later).toMatchObject({ due: 1, deleted: 1, failed: 0 });
    expect(world.posts).toHaveLength(0);
  });

  it("does not spin: a reel kept for retry is excluded from the same run's next query", async () => {
    const world = makeWorld({
      posts: [reel('r1')],
      blobs: { 'blob-r1': 'alice' },
      failing: ['blob-r1'],
    });
    await world.scheduler.purgeOnce();
    // One selection that found it, one that excluded it and came back empty - never a third.
    const selects = world.sql.filter((s) => s.startsWith('SELECT id, "authorId"'));
    expect(selects).toHaveLength(2);
    expect(world.purgeCalls).toHaveLength(1);
  });

  it('keeps the row and logs when the media service is unreachable', async () => {
    const world = makeWorld({ posts: [reel('r1')], blobs: { 'blob-r1': 'alice' } });
    world.setMediaDown(true);

    const report = await world.scheduler.purgeOnce();

    expect(report).toMatchObject({ due: 1, deleted: 0, failed: 1 });
    expect(world.posts).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('reel=r1 kept for the next tick');
  });

  it('treats a blob the media service did not answer for as NOT deleted', async () => {
    const world = makeWorld({ posts: [reel('r1')], blobs: { 'blob-r1': 'alice' } });
    world.retention.purgeReelBlobs.mockResolvedValueOnce({});

    const report = await world.scheduler.purgeOnce();

    expect(report).toMatchObject({ deleted: 0, failed: 1 });
    expect(world.posts).toHaveLength(1);
  });
});

describe('ReelRetentionScheduler - the scheduled entry point', () => {
  it('never throws out of the cron callback, and logs a run that failed outright', async () => {
    const world = makeWorld({ posts: [], blobs: {} });
    world.scheduler.purgeOnce = jest.fn(() => Promise.reject(new Error('db down')));
    await expect(world.scheduler.purgeExpiredReels()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('run failed');
  });

  it('skips a tick while the previous run is still going, and says so', async () => {
    const world = makeWorld({ posts: [], blobs: {} });
    let release!: () => void;
    const purgeOnce = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({} as never);
        })
    );
    world.scheduler.purgeOnce = purgeOnce as never;
    const first = world.scheduler.purgeExpiredReels();
    await world.scheduler.purgeExpiredReels();
    expect(purgeOnce).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('still going');
    release();
    await first;
  });
});
