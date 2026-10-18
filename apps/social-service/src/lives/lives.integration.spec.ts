/**
 * LIVES AGAINST A REAL POSTGRESQL - migration 091, `LivesService`, the live sweep and the lives part
 * of the account erasure (WP-L2, WP-L3; docs/wiki/services/lives.md).
 *
 * What a mocked repository cannot judge is exactly what this module rests on: the row lock that
 * orders a segment and an end, the partial unique index (one open live per broadcaster), the CHECK
 * tying an end to its reason, the cascade from a live to its segments and removed viewers, and the
 * sweep's predicates read against the DATABASE clock. So the service runs here on a real connection,
 * with the media store replaced by an in-memory one that keeps the media service's vocabulary.
 *
 * NO WALL CLOCK IS ASSERTED: a live "silent for two minutes" or "started 61 minutes ago" is a row
 * whose timestamps were moved back by SQL, relative to the database's own `now()`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files. Run it against a throwaway
 * PostgreSQL:
 *
 *   docker run -d --rm --name live-it -e POSTGRES_PASSWORD=it -p 55447:5432 postgres:18-alpine
 *   SOCIAL_IT_DATABASE_URL=postgres://postgres:it@localhost:55447/postgres bun run test -- lives.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { HttpStatus } from '@nestjs/common';
import { LIVE_ENTITIES } from './lives.module';
import { LivesService } from './lives.service';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import type { LivePurgeResult, LiveSegmentStore } from './live-segment-store';
import type { AssociationsService } from '../associations/associations.service';
import type { ModerationService } from '../moderation/moderation.service';
import {
  DELETED_ACCOUNT,
  LIVES_ERASURE_STATEMENTS,
  runErasureStatements,
} from '../internal/account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '091_lives.sql'), 'utf8');

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);
const KEY = '0f'.repeat(32);
const ASSO = '11111111-1111-4111-8111-111111111111';

/**
 * The media store, in memory, answering as `POST media/internal/live-purge` does: the deletes, the
 * failures, and a RE-LISTING after them. `failStore` / `failPurge` make it refuse; `holdStore`
 * suspends one store until released, which is how a test holds an ingest inside its row lock.
 */
class MemoryStore implements LiveSegmentStore {
  readonly objects = new Map<string, Buffer>();
  failStore = false;
  /** The purge call fails in transport (it throws). */
  failPurge = false;
  /** The purge ANSWERS, but with a store that refused some deletes (the media service's `failed`). */
  refuseDeletes = false;
  private hold: { entered: () => void; release: Promise<void> } | null = null;

  /** The next store waits for `release`; resolves `entered` once it is inside. */
  holdNextStore(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const releaseP = new Promise<void>((r) => (release = r));
    this.hold = { entered, release: releaseP };
    return { entered: enteredP, release };
  }

  async store(liveId: string, name: string, data: Buffer): Promise<void> {
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.entered();
      await hold.release;
    }
    if (this.failStore) throw Object.assign(new Error('store down'), { code: 'ECONNREFUSED' });
    this.objects.set(`live/${liveId}/${name}`, data);
  }

  async purge(liveId: string): Promise<LivePurgeResult> {
    const prefix = `live/${liveId}/`;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
    if (this.failPurge) throw Object.assign(new Error('store down'), { code: 'ECONNREFUSED' });
    if (this.refuseDeletes) return { deleted: 0, failed: keys.length, remaining: keys.length };
    for (const k of keys) this.objects.delete(k);
    return { deleted: keys.length, failed: 0, remaining: 0 };
  }

  countFor(liveId: string): number {
    return [...this.objects.keys()].filter((k) => k.startsWith(`live/${liveId}/`)).length;
  }
}

/** The HTTP status a Nest exception would answer, and its body's `code`. */
async function refusal(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    const body = err.getResponse?.() as { code?: string } | undefined;
    return { status: err.getStatus?.() ?? -1, code: body?.code };
  }
  throw new Error('expected a refusal, got an answer');
}

maybe('lives against PostgreSQL (migration 091)', () => {
  const schema = `lives_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let store: MemoryStore;
  let lives: LivesService;
  let sweeper: LiveRetentionScheduler;
  const muted = new Set<string>();
  const mayActAs = new Set<string>();
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: LIVE_ENTITIES,
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // The one other table the service reads, in the shape it reads it (core-service owns it).
    await q(`CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255))`);
    // Applied TWICE: the deploy re-runs a file whose successor failed, so it must be a no-op then.
    await q(MIGRATION);
    await q(MIGRATION);
  });

  beforeEach(async () => {
    await q(`DELETE FROM lives`);
    await q(`DELETE FROM user_blocks`);
    muted.clear();
    mayActAs.clear();
    store = new MemoryStore();
    lives = new LivesService(
      ds,
      store,
      {
        mayAct: async (userId: string, associationId: string) =>
          mayActAs.has(`${userId}:${associationId}`),
      } as unknown as AssociationsService,
      { isUserMuted: async (userId: string) => muted.has(userId) } as unknown as ModerationService
    );
    sweeper = new LiveRetentionScheduler(lives);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const start = (who = ALICE) => lives.start(who, { key: KEY });
  const segment = (n: number) => Buffer.from(`sealed segment ${n}`);

  it('builds the schema the entities declare: synchronize would change nothing on a live table', async () => {
    const pending = (await ds.driver.createSchemaBuilder().log()).upQueries.map((u) => u.query);
    expect(pending.filter((sql) => /live/.test(sql))).toEqual([]);
  });

  describe('the live row and its key (WP-L2)', () => {
    it('serves the key to any member, as a post CEK is', async () => {
      const live = await start();
      expect(live.key).toBe(KEY);
      await expect(lives.get(BOB, live.id)).resolves.toMatchObject({ id: live.id, key: KEY });
      await expect(lives.listOpen(BOB)).resolves.toEqual([
        expect.objectContaining({ id: live.id, broadcasterId: ALICE }),
      ]);
    });

    it('refuses a malformed key, a muted member, and an association the member may not speak for', async () => {
      expect(await refusal(lives.start(ALICE, { key: 'short' }))).toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: 'LIVE_KEY_INVALID',
      });
      muted.add(BOB);
      expect((await refusal(lives.start(BOB, { key: KEY }))).code).toBe('LIVE_MUTED');
      expect((await refusal(lives.start(ALICE, { key: KEY, associationId: ASSO }))).code).toBe(
        'LIVE_ASSOCIATION_FORBIDDEN'
      );
      mayActAs.add(`${ALICE}:${ASSO}`);
      await expect(lives.start(ALICE, { key: KEY, associationId: ASSO })).resolves.toMatchObject({
        associationId: ASSO,
      });
    });

    it('holds ONE open live per broadcaster in the database, and frees it at the end', async () => {
      const first = await start();
      expect(await refusal(start())).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'LIVE_ALREADY_OPEN',
      });
      await lives.end(ALICE, first.id);
      await expect(start()).resolves.toBeDefined();
    });

    it('REFUSES A REMOVED VIEWER the key, the manifest and the listing - and only that viewer', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await lives.removeViewer(ALICE, live.id, BOB);
      // Idempotent: a second removal changes nothing.
      await lives.removeViewer(ALICE, live.id, BOB);

      expect(await refusal(lives.get(BOB, live.id))).toEqual({
        status: HttpStatus.FORBIDDEN,
        code: 'LIVE_VIEWER_REMOVED',
      });
      expect((await refusal(lives.manifest(BOB, live.id))).code).toBe('LIVE_VIEWER_REMOVED');
      await expect(lives.listOpen(BOB)).resolves.toEqual([]);

      await expect(lives.get(CAROL, live.id)).resolves.toMatchObject({ key: KEY });
      await expect(lives.manifest(CAROL, live.id)).resolves.toMatchObject({ nextIndex: 1 });
    });

    it('lets only the broadcaster remove, and never themselves', async () => {
      const live = await start();
      expect((await refusal(lives.removeViewer(BOB, live.id, CAROL))).code).toBe(
        'LIVE_NOT_BROADCASTER'
      );
      expect((await refusal(lives.removeViewer(ALICE, live.id, ALICE))).code).toBe(
        'LIVE_VIEWER_IS_SELF'
      );
    });

    it('hides a live across a block, in either direction, as the feed does', async () => {
      const live = await start();
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [ALICE, BOB]);
      expect((await refusal(lives.get(BOB, live.id))).status).toBe(HttpStatus.NOT_FOUND);
      await expect(lives.listOpen(BOB)).resolves.toEqual([]);
    });

    it('SERVES NOTHING AFTER endedAt: key, manifest, segment and removal all answer 410', async () => {
      const live = await start();
      // The store refuses the purge, so the ended row is still there to be asked about.
      store.failPurge = true;
      await lives.ingest(ALICE, live.id, 0, segment(0));
      const ended = await lives.end(ALICE, live.id);
      expect(ended.endReason).toBe('broadcaster');

      for (const p of [
        lives.get(BOB, live.id),
        lives.get(ALICE, live.id),
        lives.manifest(BOB, live.id),
        lives.ingest(ALICE, live.id, 1, segment(1)),
        lives.removeViewer(ALICE, live.id, CAROL),
      ]) {
        expect(await refusal(p)).toEqual({ status: HttpStatus.GONE, code: 'LIVE_ENDED' });
      }
      await expect(lives.listOpen(BOB)).resolves.toEqual([]);
      // Idempotent: the end answered again, never a second end.
      await expect(lives.end(ALICE, live.id)).resolves.toMatchObject({
        endedAt: ended.endedAt,
        endReason: 'broadcaster',
      });
      expect((await refusal(lives.end(BOB, live.id))).code).toBe('LIVE_NOT_BROADCASTER');
    });
  });

  describe('segment ingest and the manifest (WP-L3)', () => {
    it('stores a gapless sequence and REFUSES A SEGMENT OUT OF ORDER', async () => {
      const live = await start();
      await expect(lives.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        index: 0,
        nextIndex: 1,
      });
      expect(await refusal(lives.ingest(ALICE, live.id, 2, segment(2)))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'LIVE_SEGMENT_OUT_OF_ORDER',
      });
      await expect(lives.ingest(ALICE, live.id, 1, segment(1))).resolves.toMatchObject({
        nextIndex: 2,
      });
      expect(store.countFor(live.id)).toBe(2);
    });

    it('answers a repeated segment with the same bytes as the first time, and refuses different bytes', async () => {
      const live = await start();
      const first = await lives.ingest(ALICE, live.id, 0, segment(0));
      await expect(lives.ingest(ALICE, live.id, 0, segment(0))).resolves.toEqual(first);
      expect((await refusal(lives.ingest(ALICE, live.id, 0, segment(9)))).code).toBe(
        'LIVE_SEGMENT_CONFLICT'
      );
      expect(store.countFor(live.id)).toBe(1);
    });

    it('takes segments from the broadcaster only', async () => {
      const live = await start();
      expect((await refusal(lives.ingest(BOB, live.id, 0, segment(0)))).code).toBe(
        'LIVE_NOT_BROADCASTER'
      );
    });

    it('records nothing when the store refuses: 503, and the same index is accepted afterwards', async () => {
      const live = await start();
      store.failStore = true;
      expect(await refusal(lives.ingest(ALICE, live.id, 0, segment(0)))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'LIVE_STORE_UNAVAILABLE',
      });
      store.failStore = false;
      await expect(lives.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        nextIndex: 1,
      });
    });

    it('lists the newest window by default, from an index on request, with server-chosen names', async () => {
      const live = await start();
      const names: string[] = [];
      for (let i = 0; i < 12; i++)
        names.push((await lives.ingest(ALICE, live.id, i, segment(i))).name);
      const latest = await lives.manifest(BOB, live.id);
      expect(latest.nextIndex).toBe(12);
      expect(latest.segments.map((s) => s.index)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(latest.segments[0]).toEqual({ index: 2, name: names[2], bytes: segment(2).length });
      expect(latest.lastSegmentAt).not.toBeNull();
      const from = await lives.manifest(BOB, live.id, 11);
      expect(from.segments.map((s) => s.index)).toEqual([11]);
      // A name is a random uuid, not the index: the next one cannot be guessed.
      expect(new Set(names).size).toBe(12);
    });

    it('THE MANIFEST STOPS AT endedAt, and the end deletes the segments and the row at once', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await lives.ingest(ALICE, live.id, 1, segment(1));
      await lives.end(ALICE, live.id);
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(await q(`SELECT 1 FROM live_segments WHERE "liveId" = $1`, [live.id])).toEqual([]);
      expect((await refusal(lives.manifest(BOB, live.id))).status).toBe(HttpStatus.NOT_FOUND);
    });

    it('orders an end AFTER an ingest that holds the row: the segment stored inside is purged with it', async () => {
      const live = await start();
      const hold = store.holdNextStore();
      const ingest = lives.ingest(ALICE, live.id, 0, segment(0));
      await hold.entered;
      const end = lives.end(ALICE, live.id);
      // The proof the end is WAITING on the ingest's row lock, read from the server.
      for (let i = 0; ; i++) {
        const waiting = await admin.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE lives SET "endedAt"%'`
        );
        if (waiting.rows.length > 0) break;
        if (i > 200) throw new Error('the end never waited on the ingest');
        await new Promise((r) => setTimeout(r, 10));
      }
      hold.release();
      await expect(ingest).resolves.toMatchObject({ index: 0 });
      await expect(end).resolves.toMatchObject({ endReason: 'broadcaster' });
      // The segment stored under the lock did not outlive the purge that followed the end.
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
    });
  });

  describe('the sweep (Q5, Q10)', () => {
    it('ends a live whose broadcaster went silent past the window, and deletes it', async () => {
      const silent = await start(ALICE);
      const talking = await start(BOB);
      await lives.ingest(ALICE, silent.id, 0, segment(0));
      await lives.ingest(BOB, talking.id, 0, segment(0));
      await q(
        `UPDATE lives SET "lastSegmentAt" = now() - interval '2 minutes',
                          "startedAt" = now() - interval '3 minutes' WHERE id = $1`,
        [silent.id]
      );
      const report = await sweeper.sweepOnce();
      expect(report).toEqual({ ended: 1, deleted: 1, kept: 0 });
      expect(store.countFor(silent.id)).toBe(0);
      await expect(lives.get(CAROL, talking.id)).resolves.toBeDefined();
      expect(store.countFor(talking.id)).toBe(1);
    });

    it('ends a live that never sent a segment within the window of its start', async () => {
      const live = await start();
      await q(`UPDATE lives SET "startedAt" = now() - interval '2 minutes' WHERE id = $1`, [
        live.id,
      ]);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 1, deleted: 1, kept: 0 });
    });

    it('ends a live past its hour, from the sweep or from the ingest that finds it', async () => {
      const bySweep = await start(ALICE);
      const byIngest = await start(BOB);
      await q(
        `UPDATE lives SET "startedAt" = now() - interval '61 minutes', "lastSegmentAt" = now()
          WHERE id = ANY($1::uuid[])`,
        [[bySweep.id, byIngest.id]]
      );
      store.failPurge = true;
      expect((await refusal(lives.ingest(BOB, byIngest.id, 0, segment(0)))).status).toBe(
        HttpStatus.GONE
      );
      await sweeper.sweepOnce();
      const reasons = await q(`SELECT id, "endReason" FROM lives ORDER BY "endReason"`);
      expect(reasons).toEqual(
        expect.arrayContaining([
          { id: bySweep.id, endReason: 'max_duration' },
          { id: byIngest.id, endReason: 'max_duration' },
        ])
      );
    });

    it('EVERYTHING IS GONE AFTER THE SWEEP: a purge refused at the end is finished by the next run', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await lives.removeViewer(ALICE, live.id, BOB);
      store.failPurge = true;
      await lives.end(ALICE, live.id);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 1 });
      expect(store.countFor(live.id)).toBe(1);

      store.failPurge = false;
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0 });
      expect(store.objects.size).toBe(0);
      for (const table of ['lives', 'live_segments', 'live_removed_viewers']) {
        expect(await q(`SELECT 1 FROM ${table}`)).toEqual([]);
      }
      // And a second run finds nothing to do.
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 0 });
    });

    it('keeps the row while the store still lists a segment, even when the call itself answered', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      store.refuseDeletes = true;
      await lives.end(ALICE, live.id);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 1 });
      expect(await q(`SELECT "endReason" FROM lives WHERE id = $1`, [live.id])).toEqual([
        { endReason: 'broadcaster' },
      ]);
      store.refuseDeletes = false;
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0 });
    });

    it('never ends an open live through the purge path, whatever id reaches it', async () => {
      const live = await start();
      await lives.purgeEnded(live.id);
      await expect(lives.get(BOB, live.id)).resolves.toBeDefined();
    });
  });

  describe('a deleted account (LIVES_ERASURE_STATEMENTS)', () => {
    const erase = (userId: string) =>
      ds.transaction((m) =>
        runErasureStatements(
          {
            write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) => (await m.query(sql, params)) as T[],
          },
          LIVES_ERASURE_STATEMENTS,
          userId
        )
      );

    it("ends and anonymises the broadcaster's live, which the sweep then deletes", async () => {
      const own = await start(ALICE);
      const other = await start(CAROL);
      await lives.ingest(ALICE, own.id, 0, segment(0));
      await lives.removeViewer(CAROL, other.id, ALICE);

      await erase(ALICE);
      const [row] = await q(
        `SELECT "broadcasterId", "endReason", "endedAt" FROM lives WHERE id = $1`,
        [own.id]
      );
      expect(row).toMatchObject({ broadcasterId: DELETED_ACCOUNT, endReason: 'erased' });
      expect(row.endedAt).not.toBeNull();
      expect(await q(`SELECT 1 FROM live_removed_viewers WHERE "viewerId" = $1`, [ALICE])).toEqual(
        []
      );
      // Idempotent: a second run changes nothing.
      await erase(ALICE);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0 });
      expect(store.countFor(own.id)).toBe(0);
      await expect(lives.get(BOB, other.id)).resolves.toBeDefined();
    });
  });
});
