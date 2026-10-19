/**
 * LIVES AGAINST A REAL POSTGRESQL - migration 091, `LivesService`, the live sweep and the lives part
 * of the account erasure (WP-L2, WP-L3; docs/wiki/services/lives.md).
 *
 * What a mocked repository cannot judge is exactly what this module rests on: the row lock and the
 * committed reservation that order a segment and an end without holding a pooled connection across
 * the store, the partial unique index (one open live per broadcaster), the CHECK
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
import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { LIVE_ENTITIES } from './lives.module';
import { LivesService } from './lives.service';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import { seatMember, type LiveSeats } from './live-seats';
import type { LivePurgeResult, LiveSegmentStore } from './live-segment-store';
import {
  LIVE_BYTE_BUDGET,
  LIVE_INGEST_MAX_CONCURRENT,
  LIVE_SEGMENT_BURST,
  LIVE_STARTS_PER_HOUR,
} from './live.constants';
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
 * failures, and a RE-LISTING after them. `failStore` / `failPurge` make it refuse; `holdNextStore`
 * suspends the next store until released, `holdStores` every store - which is how a test stalls a
 * slow media-service while an ingest is between its reservation and its confirm.
 */
class MemoryStore implements LiveSegmentStore {
  readonly objects = new Map<string, Buffer>();
  failStore = false;
  /** The purge call fails in transport (it throws). */
  failPurge = false;
  /** The purge ANSWERS, but with a store that refused some deletes (the media service's `failed`). */
  refuseDeletes = false;
  private hold: { entered: () => void; release: Promise<void> } | null = null;
  private gate: { entered: number; release: Promise<void> } | null = null;

  /** The next store waits for `release`; resolves `entered` once it is inside. */
  holdNextStore(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const releaseP = new Promise<void>((r) => (release = r));
    this.hold = { entered, release: releaseP };
    return { entered: enteredP, release };
  }

  /** EVERY store waits until `release`; `entered()` counts the ones waiting. */
  holdStores(): { entered: () => number; release: () => void } {
    let release!: () => void;
    const gate = { entered: 0, release: new Promise<void>((r) => (release = r)) };
    this.gate = gate;
    return {
      entered: () => gate.entered,
      release: () => {
        this.gate = null;
        release();
      },
    };
  }

  async store(liveId: string, name: string, data: Buffer): Promise<void> {
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.entered();
      await hold.release;
    }
    const gate = this.gate;
    if (gate) {
      gate.entered += 1;
      await gate.release;
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

  async listLives(): Promise<string[]> {
    return [...new Set([...this.objects.keys()].map((k) => k.split('/')[1]))];
  }

  countFor(liveId: string): number {
    return [...this.objects.keys()].filter((k) => k.startsWith(`live/${liveId}/`)).length;
  }
}

/**
 * The viewer seats, in memory, answering as `LiveSeats` does: one seat per (live, viewer), a cap,
 * and the typed 503 `LIVE_FULL` past it. The cap's ATOMICITY is the Lua script's, proven against a
 * real Redis in `live-seats.spec.ts`; this proves where the service takes and gives seats.
 */
class MemorySeats {
  cap = Number.POSITIVE_INFINITY;
  readonly held = new Set<string>();

  async take(liveId: string, viewerId: string): Promise<void> {
    const member = seatMember(liveId, viewerId);
    if (!this.held.has(member) && this.held.size >= this.cap) {
      throw new ServiceUnavailableException({ code: 'LIVE_FULL', viewerCap: this.cap });
    }
    this.held.add(member);
  }

  async release(liveId: string, viewerId: string): Promise<void> {
    this.held.delete(seatMember(liveId, viewerId));
  }

  async releaseLive(liveId: string): Promise<number> {
    const prefix = seatMember(liveId, '');
    const gone = [...this.held].filter((m) => m.startsWith(prefix));
    for (const m of gone) this.held.delete(m);
    return gone.length;
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
  let seats: MemorySeats;
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
    await q(`DELETE FROM live_starts`);
    await q(`DELETE FROM user_blocks`);
    muted.clear();
    mayActAs.clear();
    store = new MemoryStore();
    seats = new MemorySeats();
    lives = new LivesService(
      ds,
      store,
      {
        mayAct: async (userId: string, associationId: string) =>
          mayActAs.has(`${userId}:${associationId}`),
      } as unknown as AssociationsService,
      { isUserMuted: async (userId: string) => muted.has(userId) } as unknown as ModerationService,
      seats as unknown as LiveSeats
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

  describe('the viewer cap (WP-L4)', () => {
    it('seats a viewer at the key read, keeps it on every poll, and refuses viewer N+1 with LIVE_FULL', async () => {
      seats.cap = 1;
      const live = await start();
      await lives.get(BOB, live.id);
      await lives.manifest(BOB, live.id);
      expect([...seats.held]).toEqual([`${live.id}:${BOB}`]);
      expect(await refusal(lives.get(CAROL, live.id))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'LIVE_FULL',
      });
      expect((await refusal(lives.manifest(CAROL, live.id))).code).toBe('LIVE_FULL');
      // The broadcaster takes no seat, however full the host is.
      await expect(lives.manifest(ALICE, live.id)).resolves.toMatchObject({ liveId: live.id });
      // A viewer leaving gives its seat to the next one in - whatever case its URL spelled the id in.
      await lives.leave(BOB, live.id.toUpperCase());
      await expect(lives.get(CAROL, live.id)).resolves.toMatchObject({ id: live.id });
    });

    it('answers removed, blocked and ended BEFORE full, and frees the seat of a removed viewer', async () => {
      seats.cap = 1;
      const live = await start();
      await lives.get(BOB, live.id);
      await lives.removeViewer(ALICE, live.id, BOB);
      expect(seats.held.size).toBe(0);
      expect((await refusal(lives.get(BOB, live.id))).code).toBe('LIVE_VIEWER_REMOVED');
      await lives.get(CAROL, live.id);
      await q(`INSERT INTO user_blocks VALUES ($1, $2)`, [ALICE, BOB]);
      expect((await refusal(lives.get(BOB, live.id))).code).toBe('LIVE_NOT_FOUND');
      // The store refuses the purge, so the ended row is still there to be asked about; and no seat
      // is left, so a "full" would win if it were asked first.
      store.failPurge = true;
      await lives.end(ALICE, live.id);
      // The end frees the live's seats at once, even with the purge refused (CAROL's, here).
      expect(seats.held.size).toBe(0);
      seats.cap = 0;
      expect((await refusal(lives.manifest(CAROL, live.id))).code).toBe('LIVE_ENDED');
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

    it('orders an end against an ingest still storing: nothing recorded after it, nothing outlives the purge', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      const hold = store.holdNextStore();
      const ingest = lives.ingest(ALICE, live.id, 1, segment(1));
      await hold.entered;
      // The end does not wait on the store: no lock is held across it. Its purge is KEPT, because a
      // segment is still storing - the store it would otherwise race.
      await expect(lives.end(ALICE, live.id)).resolves.toMatchObject({ endReason: 'broadcaster' });
      expect(
        await q(`SELECT "pendingName" IS NOT NULL AS p FROM lives WHERE id = $1`, [live.id])
      ).toEqual([{ p: true }]);
      expect(store.countFor(live.id)).toBe(1);

      hold.release();
      expect(await refusal(ingest)).toEqual({ status: HttpStatus.GONE, code: 'LIVE_ENDED' });
      // The confirm recorded nothing after the end, and purged the live itself.
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(await q(`SELECT 1 FROM live_segments WHERE "liveId" = $1`, [live.id])).toEqual([]);
    });
  });

  describe('the reservation: no pooled connection held across the store (P2-1)', () => {
    it('A STALLED STORE DOES NOT BLOCK AN UNRELATED QUERY on the same pool, even a pool of ONE', async () => {
      const one = new DataSource({
        type: 'postgres',
        url: URL,
        entities: LIVE_ENTITIES,
        synchronize: false,
        extra: { options: `-c search_path=${schema}`, max: 1 },
      });
      await one.initialize();
      try {
        const onOne = new LivesService(
          one,
          store,
          { mayAct: async () => false } as unknown as AssociationsService,
          { isUserMuted: async () => false } as unknown as ModerationService,
          seats as unknown as LiveSeats
        );
        const live = await onOne.start(ALICE, { key: KEY });
        const hold = store.holdNextStore();
        const ingest = onOne.ingest(ALICE, live.id, 0, segment(0));
        await hold.entered;
        // The ONE connection is free while media-service is stalled: another route's query runs.
        await expect(one.query(`SELECT 1 AS ok`)).resolves.toEqual([{ ok: 1 }]);
        await expect(onOne.manifest(BOB, live.id)).resolves.toMatchObject({ nextIndex: 0 });
        hold.release();
        await expect(ingest).resolves.toMatchObject({ index: 0, nextIndex: 1 });
      } finally {
        await one.destroy();
      }
    });

    it('releases the index when the store fails: nothing pending, the same index accepted at once', async () => {
      const live = await start();
      store.failStore = true;
      expect((await refusal(lives.ingest(ALICE, live.id, 0, segment(0)))).code).toBe(
        'LIVE_STORE_UNAVAILABLE'
      );
      expect(
        await q(`SELECT "pendingName", "pendingAt", "nextIndex" FROM lives WHERE id = $1`, [
          live.id,
        ])
      ).toEqual([{ pendingName: null, pendingAt: null, nextIndex: 0 }]);
      store.failStore = false;
      await expect(lives.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        nextIndex: 1,
      });
    });

    it('refuses a second ingest of an index still storing, and takes over an ABANDONED reservation', async () => {
      const live = await start();
      const hold = store.holdNextStore();
      const first = lives.ingest(ALICE, live.id, 0, segment(0));
      await hold.entered;
      expect(await refusal(lives.ingest(ALICE, live.id, 0, segment(0)))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'LIVE_SEGMENT_IN_PROGRESS',
      });
      hold.release();
      await expect(first).resolves.toMatchObject({ nextIndex: 1 });

      // A reservation whose ingest died: older than the store's timeout, moved back by SQL.
      await q(
        `UPDATE lives SET "pendingName" = gen_random_uuid(), "pendingSha256" = repeat('0', 64),
                          "pendingAt" = now() - interval '10 minutes' WHERE id = $1`,
        [live.id]
      );
      await expect(lives.ingest(ALICE, live.id, 1, segment(1))).resolves.toMatchObject({
        nextIndex: 2,
      });
    });

    it('a purge waits for a live reservation, and ignores an abandoned one', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await q(
        `UPDATE lives SET "endedAt" = now(), "endReason" = 'dropped', "pendingName" = gen_random_uuid(),
                          "pendingSha256" = repeat('0', 64), "pendingAt" = now() WHERE id = $1`,
        [live.id]
      );
      await expect(lives.purgeEnded(live.id)).resolves.toBe('kept');
      expect(store.countFor(live.id)).toBe(1);
      await q(`UPDATE lives SET "pendingAt" = now() - interval '10 minutes' WHERE id = $1`, [
        live.id,
      ]);
      await expect(lives.purgeEnded(live.id)).resolves.toBe('deleted');
      expect(store.countFor(live.id)).toBe(0);
    });

    it('never touches an OPEN live through the purge path: its segments stay', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await expect(lives.purgeEnded(live.id)).resolves.toBe('kept');
      expect(store.countFor(live.id)).toBe(1);
    });

    it(`refuses an ingest beyond ${LIVE_INGEST_MAX_CONCURRENT} storing at once: 503 LIVE_INGEST_BUSY`, async () => {
      const broadcasters = Array.from({ length: LIVE_INGEST_MAX_CONCURRENT + 1 }, (_, i) =>
        String(i + 1)
          .repeat(64)
          .slice(0, 64)
      );
      const ids: string[] = [];
      for (const b of broadcasters) ids.push((await lives.start(b, { key: KEY })).id);
      const gate = store.holdStores();
      const running = broadcasters
        .slice(0, LIVE_INGEST_MAX_CONCURRENT)
        .map((b, i) => lives.ingest(b, ids[i], 0, segment(0)));
      for (let i = 0; gate.entered() < LIVE_INGEST_MAX_CONCURRENT; i++) {
        if (i > 500) throw new Error('the ingests never reached the store');
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(
        await refusal(
          lives.ingest(
            broadcasters[LIVE_INGEST_MAX_CONCURRENT],
            ids[LIVE_INGEST_MAX_CONCURRENT],
            0,
            segment(0)
          )
        )
      ).toEqual({ status: HttpStatus.SERVICE_UNAVAILABLE, code: 'LIVE_INGEST_BUSY' });
      gate.release();
      await Promise.all(running);
      await expect(
        lives.ingest(
          broadcasters[LIVE_INGEST_MAX_CONCURRENT],
          ids[LIVE_INGEST_MAX_CONCURRENT],
          0,
          segment(0)
        )
      ).resolves.toMatchObject({ nextIndex: 1 });
    });
  });

  describe('what one broadcaster may store (P2-2)', () => {
    it('refuses a segment that would cross the byte budget: 413, nothing recorded', async () => {
      const live = await start();
      await q(`UPDATE lives SET "storedBytes" = $2 WHERE id = $1`, [
        live.id,
        LIVE_BYTE_BUDGET - segment(0).length + 1,
      ]);
      expect(await refusal(lives.ingest(ALICE, live.id, 0, segment(0)))).toEqual({
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        code: 'LIVE_BUDGET_EXHAUSTED',
      });
      await q(`UPDATE lives SET "storedBytes" = $2 WHERE id = $1`, [
        live.id,
        LIVE_BYTE_BUDGET - segment(0).length,
      ]);
      await lives.ingest(ALICE, live.id, 0, segment(0));
      expect(await q(`SELECT "storedBytes" FROM lives WHERE id = $1`, [live.id])).toEqual([
        { storedBytes: String(LIVE_BYTE_BUDGET) },
      ]);
    });

    it("counts the segments against the live's age: past the burst, 429 until the live is older", async () => {
      const live = await start();
      // The live's age is read from the database clock; a start moved AHEAD of now() by SQL takes
      // ten segments off the allowance, whatever this test's own timing.
      await q(`UPDATE lives SET "startedAt" = now() + interval '10 seconds' WHERE id = $1`, [
        live.id,
      ]);
      const allowed = LIVE_SEGMENT_BURST - 10;
      for (let i = 0; i < allowed; i++) await lives.ingest(ALICE, live.id, i, segment(i));
      expect(await refusal(lives.ingest(ALICE, live.id, allowed, segment(allowed)))).toEqual({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'LIVE_SEGMENT_TOO_FAST',
      });
      // A live 30 s old may hold burst + 30 segments.
      await q(`UPDATE lives SET "startedAt" = now() - interval '30 seconds' WHERE id = $1`, [
        live.id,
      ]);
      await expect(lives.ingest(ALICE, live.id, allowed, segment(allowed))).resolves.toMatchObject({
        nextIndex: allowed + 1,
      });
    });

    it(`refuses a ${LIVE_STARTS_PER_HOUR + 1}th start in the hour, and forgets a start after it`, async () => {
      for (let i = 0; i < LIVE_STARTS_PER_HOUR; i++) {
        const live = await start(CAROL);
        await lives.end(CAROL, live.id);
      }
      expect(await refusal(start(CAROL))).toEqual({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'LIVE_START_RATE',
      });
      // Another account is not counted with it.
      await expect(start(BOB)).resolves.toBeDefined();
      await q(`UPDATE live_starts SET "startedAt" = now() - interval '61 minutes'`);
      await sweeper.sweepOnce();
      expect(await q(`SELECT 1 FROM live_starts WHERE "broadcasterId" = $1`, [CAROL])).toEqual([]);
      await expect(start(CAROL)).resolves.toBeDefined();
    });
  });

  describe('the orphan reaper', () => {
    it('empties a segment folder with NO live row behind it, and leaves every live with a row alone', async () => {
      const kept = await start(ALICE);
      await lives.ingest(ALICE, kept.id, 0, segment(0));
      const orphan = '99999999-9999-4999-8999-999999999999';
      // A store that outlived its timeout and landed after its live's purge: a folder, no row.
      store.objects.set(
        `live/${orphan}/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
        segment(9)
      );
      const report = await sweeper.sweepOnce();
      expect(report.orphans).toBe(1);
      expect(store.countFor(orphan)).toBe(0);
      expect(store.countFor(kept.id)).toBe(1);
      // Nothing left to reap.
      expect((await sweeper.sweepOnce()).orphans).toBe(0);
    });

    it('answers a repeated end after the purge with 404, as the contract says', async () => {
      const live = await start();
      await lives.end(ALICE, live.id);
      expect(await refusal(lives.end(ALICE, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
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
      expect(report).toEqual({ ended: 1, deleted: 1, kept: 0, orphans: 0 });
      expect(store.countFor(silent.id)).toBe(0);
      await expect(lives.get(CAROL, talking.id)).resolves.toBeDefined();
      expect(store.countFor(talking.id)).toBe(1);
    });

    it('ends a live that never sent a segment within the window of its start', async () => {
      const live = await start();
      await q(`UPDATE lives SET "startedAt" = now() - interval '2 minutes' WHERE id = $1`, [
        live.id,
      ]);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 1, deleted: 1, kept: 0, orphans: 0 });
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
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 1, orphans: 0 });
      expect(store.countFor(live.id)).toBe(1);

      store.failPurge = false;
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0, orphans: 0 });
      expect(store.objects.size).toBe(0);
      for (const table of ['lives', 'live_segments', 'live_removed_viewers']) {
        expect(await q(`SELECT 1 FROM ${table}`)).toEqual([]);
      }
      // And a second run finds nothing to do.
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 0, orphans: 0 });
    });

    it('keeps the row while the store still lists a segment, even when the call itself answered', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      store.refuseDeletes = true;
      await lives.end(ALICE, live.id);
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 0, kept: 1, orphans: 0 });
      expect(await q(`SELECT "endReason" FROM lives WHERE id = $1`, [live.id])).toEqual([
        { endReason: 'broadcaster' },
      ]);
      store.refuseDeletes = false;
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0, orphans: 0 });
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
      expect(await sweeper.sweepOnce()).toEqual({ ended: 0, deleted: 1, kept: 0, orphans: 0 });
      expect(store.countFor(own.id)).toBe(0);
      await expect(lives.get(BOB, other.id)).resolves.toBeDefined();
    });
  });
});
