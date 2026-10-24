/**
 * LIVES AGAINST A REAL POSTGRESQL - migrations 091 and 094, `LivesService`, the live sweep, the push
 * to the followers when a live goes on air, and the lives part of the account erasure (WP-L2, WP-L3,
 * WP-L7; docs/wiki/services/lives.md).
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
import { createCipheriv, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LIVE_ENTITIES } from './lives.module';
import { LivesService } from './lives.service';
import { LiveChatService } from './live-chat.service';
import { liveChatAad } from './live-chat-seal';
import { LIVE_KEY_ENCRYPTION_SECRET_ENV } from './live-key-at-rest';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import { LiveReportAgeScheduler } from './live-report-age.scheduler';
import { LiveAnnouncer, liveAudienceSql } from './live-announcer';
import { seatMember, type LiveSeats } from './live-seats';
import type { LivePurgeResult, LiveSegmentStore } from './live-segment-store';
import {
  LIVE_BYTE_BUDGET,
  LIVE_INGEST_MAX_CONCURRENT,
  LIVE_SEGMENT_BURST,
  LIVE_RULES_VERSION,
  LIVE_STARTS_PER_HOUR,
} from './live.constants';
import type { AssociationsService } from '../associations/associations.service';
import { ModerationService } from '../moderation/moderation.service';
import { ContentReport } from '../moderation/entities/content-report.entity';
import type { UserModeration } from '../moderation/entities/user-moderation.entity';
import type { Repository } from 'typeorm';
import type { PostNotificationsService } from '../posts/post-notifications.service';
import {
  DELETED_ACCOUNT,
  LIVES_ERASURE_STATEMENTS,
  runErasureStatements,
} from '../internal/account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '091_lives.sql'), 'utf8');
const ANNOUNCED_AT = readFileSync(
  join(__dirname, '..', 'migrations', '094_live_announced_at.sql'),
  'utf8'
);
const MODERATION = readFileSync(
  join(__dirname, '..', 'migrations', '097_live_moderation.sql'),
  'utf8'
);
const CHAT = readFileSync(join(__dirname, '..', 'migrations', '098_live_chat.sql'), 'utf8');
const LADDER = readFileSync(
  join(__dirname, '..', 'migrations', '099_live_strikes_and_reported_chat_lines.sql'),
  'utf8'
);
const KEY_AT_REST = readFileSync(
  join(__dirname, '..', 'migrations', '110_live_key_at_rest.sql'),
  'utf8'
);
/** The secret live keys are sealed under in this file (migration 110). */
const KEY_SECRET = 'live-key-it-throwaway-secret-0123456789abcdef';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);
const DAVE = 'd'.repeat(64);
const EVE = 'e'.repeat(64);
/** A member who shares NO space with the others (another campus, another formation). */
const FRANK = 'f'.repeat(64);
const SE = `'saint-etienne'`;
const GA = `'gardanne'`;
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

  async take(liveId: string, viewerId: string): Promise<number> {
    const member = seatMember(liveId, viewerId);
    if (!this.held.has(member) && this.held.size >= this.cap) {
      throw new ServiceUnavailableException({ code: 'LIVE_FULL', viewerCap: this.cap });
    }
    this.held.add(member);
    return this.count(liveId);
  }

  /** How many times the broadcaster's read-only count was asked. */
  watchingCalls = 0;

  async watching(liveId: string): Promise<number | null> {
    this.watchingCalls++;
    return this.count(liveId);
  }

  private count(liveId: string): number {
    const prefix = seatMember(liveId, '');
    return [...this.held].filter((m) => m.startsWith(prefix)).length;
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

maybe('lives against PostgreSQL (migrations 091, 094, 097, 098, 099, 110)', () => {
  const schema = `lives_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let store: MemoryStore;
  let lives: LivesService;
  let sweeper: LiveRetentionScheduler;
  let announcer: LiveAnnouncer;
  /** Every `pushNotice` the announcer made - the one pipeline, faked at its seam. */
  const notices: Parameters<PostNotificationsService['pushNotice']>[0][] = [];
  /** Every in-app notification written (the cut's notice to its broadcaster, WP-L8). */
  const bell: Parameters<PostNotificationsService['createNotification']>[0][] = [];
  const notifications = {
    // Only ALICE has a name: BOB is the broadcaster with no `users` name to give.
    resolveDisplayName: async (id: string) => (id === ALICE ? 'Alice' : null),
    pushNotice: async (data: Parameters<PostNotificationsService['pushNotice']>[0]) => {
      notices.push(data);
      return data.recipientIds.length;
    },
    createNotification: async (
      data: Parameters<PostNotificationsService['createNotification']>[0]
    ) => {
      bell.push(data);
    },
  } as unknown as PostNotificationsService;
  const liveEnabledBefore = process.env.LIVE_ENABLED;
  const keySecretBefore = process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
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
      // `content_reports`: a live is reported through the posts' one report store (WP-L8, D6).
      entities: [...LIVE_ENTITIES, ContentReport],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // The one other table the service reads, in the shape it reads it (core-service owns it).
    await q(`CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255))`);
    // And the three the announcement reads (WP-L7), in the columns it reads.
    await q(
      `CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255))`
    );
    await q(
      `CREATE TABLE association_follows ("followerUserId" varchar(255), "associationId" uuid)`
    );
    await q(`CREATE TABLE associations (id uuid, name varchar, "logoMediaId" varchar)`);
    // And the ones a live's VISIBILITY reads (`liveVisibleToUserSql`, the rule of a post), in the
    // columns `reader-spaces.ts` reads. ALICE..EVE share Saint-Etienne ICM; FRANK is in Gardanne
    // ISMIN and shares no space with any of them.
    await q(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
         campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', "displayName" varchar)`
    );
    // The report store, in the columns `ModerationService` writes and the cut marks reviewed.
    await q(
      `CREATE TABLE content_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "reporterId" varchar NOT NULL, "contentType" varchar(30) NOT NULL, "contentId" varchar NOT NULL,
         reason varchar(50) NOT NULL, details text, status varchar(20) NOT NULL DEFAULT 'pending',
         "reviewedBy" varchar, "reviewedAt" timestamptz, "reportedUserId" varchar,
         "createdAt" timestamp NOT NULL DEFAULT now())`
    );
    await q(`CREATE TABLE spaces (formation varchar, campus varchar)`);
    await q(`INSERT INTO spaces (formation, campus) VALUES ('ICM', ${SE}), ('ISMIN', ${GA})`);
    await q(`CREATE TABLE association_members ("associationId" uuid, "userId" varchar(255))`);
    await q(
      `CREATE TABLE association_audiences ("associationId" uuid, formation varchar, campus varchar)`
    );
    await q(`CREATE TABLE read_grants (user_id varchar(255), campus varchar, formation varchar)`);
    for (const id of [ALICE, BOB, CAROL, DAVE, EVE]) {
      await q(
        `INSERT INTO users (id, campus, cursus) VALUES ($1, ${SE}, '[{"formation":"ICM"}]')`,
        [id]
      );
    }
    await q(
      `INSERT INTO users (id, campus, cursus) VALUES ($1, ${GA}, '[{"formation":"ISMIN"}]')`,
      [FRANK]
    );
    // Applied TWICE: the deploy re-runs a file whose successor failed, so it must be a no-op then.
    await q(MIGRATION);
    await q(MIGRATION);
    await q(ANNOUNCED_AT);
    await q(ANNOUNCED_AT);
    await q(MODERATION);
    await q(MODERATION);
    await q(CHAT);
    await q(CHAT);
    // 099 references content_reports (the kept line's report), created above as core-service's.
    await q(LADDER);
    await q(LADDER);
    await q(KEY_AT_REST);
    await q(KEY_AT_REST);
    process.env.LIVE_ENABLED = 'true';
    process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = KEY_SECRET;
  });

  beforeEach(async () => {
    await q(`DELETE FROM lives`);
    await q(`DELETE FROM live_starts`);
    await q(`DELETE FROM user_blocks`);
    await q(`DELETE FROM user_follows`);
    await q(`DELETE FROM association_follows`);
    await q(`DELETE FROM associations`);
    await q(`DELETE FROM association_members`);
    await q(`DELETE FROM association_audiences`);
    await q(`DELETE FROM read_grants`);
    await q(`DELETE FROM live_cuts`);
    await q(`DELETE FROM live_broadcast_withdrawals`);
    await q(`DELETE FROM live_chat_reported_lines`);
    await q(`DELETE FROM content_reports`);
    await q(`DELETE FROM live_rules_acceptances`);
    // Every member accepted the first-live rules, as a member who broadcast once has (L11); the
    // rules' own tests take an acceptance away.
    await q(
      `INSERT INTO live_rules_acceptances ("userId", "rulesVersion") SELECT id, $1 FROM users`,
      [LIVE_RULES_VERSION]
    );
    bell.length = 0;
    // The previous test's announcements settle first, so none lands in this one's `notices`.
    await lives?.announcementsSettled();
    notices.length = 0;
    process.env.LIVE_ENABLED = 'true';
    muted.clear();
    mayActAs.clear();
    store = new MemoryStore();
    announcer = new LiveAnnouncer(ds, notifications);
    seats = new MemorySeats();
    lives = new LivesService(
      ds,
      store,
      {
        mayAct: async (userId: string, associationId: string) =>
          mayActAs.has(`${userId}:${associationId}`),
      } as unknown as AssociationsService,
      { isUserMuted: async (userId: string) => muted.has(userId) } as unknown as ModerationService,
      seats as unknown as LiveSeats,
      announcer,
      notifications
    );
    sweeper = new LiveRetentionScheduler(lives);
  });

  afterAll(async () => {
    if (liveEnabledBefore === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = liveEnabledBefore;
    if (keySecretBefore === undefined) delete process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
    else process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = keySecretBefore;
    await lives?.announcementsSettled();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /**
   * The pushes made so far, read once every announcement started has SETTLED: `ingest` answers
   * without waiting for its announcement (WP-L7), so the proof of completion is awaited, never a delay.
   */
  const pushed = async () => {
    await lives.announcementsSettled();
    return notices;
  };
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
      // 404, the answer to a live that does not exist: a write route is no existence oracle.
      expect(await refusal(lives.removeViewer(BOB, live.id, CAROL))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
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
      expect(await refusal(lives.end(BOB, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
    });
  });

  describe('the live key at rest (migration 110)', () => {
    type KeyColumns = {
      liveKey: string | null;
      liveKeyCiphertext: string | null;
      liveKeyVersion: number | null;
    };
    const stored = async (id: string): Promise<KeyColumns> =>
      (
        (await q(
          `SELECT "liveKey", "liveKeyCiphertext", "liveKeyVersion" FROM lives WHERE id = $1`,
          [id]
        )) as KeyColumns[]
      )[0];
    /** A row as the previous release wrote it: the key in the clear, nothing sealed. */
    const legacyLive = async (who: string): Promise<string> =>
      (
        (await q(`INSERT INTO lives ("broadcasterId", "liveKey") VALUES ($1, $2) RETURNING id`, [
          who,
          KEY,
        ])) as { id: string }[]
      )[0].id;

    it('A STARTED LIVE STORES ITS KEY SEALED ONLY - and still serves it to a viewer', async () => {
      const live = await start();
      const row = await stored(live.id);
      expect(row.liveKey).toBeNull();
      expect(row.liveKeyVersion).toBe(1);
      expect(row.liveKeyCiphertext).not.toContain(KEY);
      expect(row.liveKeyCiphertext).not.toContain(Buffer.from(KEY, 'hex').toString('base64url'));
      await expect(lives.get(BOB, live.id)).resolves.toMatchObject({ key: KEY });
    });

    it('a ciphertext copied to another live does not open: 503 LIVE_KEY_UNAVAILABLE, no seat', async () => {
      const a = await start(ALICE);
      const b = await start(BOB);
      await q(
        `UPDATE lives SET "liveKeyCiphertext" = (SELECT "liveKeyCiphertext" FROM lives WHERE id = $1)
          WHERE id = $2`,
        [a.id, b.id]
      );
      expect(await refusal(lives.get(CAROL, b.id))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'LIVE_KEY_UNAVAILABLE',
      });
      expect(seats.held.has(seatMember(b.id, CAROL))).toBe(false);
    });

    it('the database holds exactly one form of a key, and a ciphertext always names its version', async () => {
      const live = await start();
      await expect(
        q(`UPDATE lives SET "liveKey" = $2 WHERE id = $1`, [live.id, KEY])
      ).rejects.toThrow(/lives_key_one_form/);
      await expect(
        q(`UPDATE lives SET "liveKeyVersion" = NULL WHERE id = $1`, [live.id])
      ).rejects.toThrow(/lives_key_version/);
    });

    it('THE BACKFILL: a plaintext row is read at once, sealed by the sweep, and a re-run touches nothing', async () => {
      const ids = [await legacyLive(BOB), await legacyLive(CAROL), await legacyLive(DAVE)];
      // The previous form is still served while it waits for the sweep.
      await expect(lives.get(EVE, ids[0])).resolves.toMatchObject({ key: KEY });
      // An INTERRUPTED run: one row was sealed before it stopped. The rest is the next run's.
      expect(await lives.sealPlaintextKeys()).toEqual({ sealed: 3, failed: 0 });
      const first = await stored(ids[0]);
      await q(
        `UPDATE lives SET "liveKey" = $2, "liveKeyCiphertext" = NULL, "liveKeyVersion" = NULL
          WHERE id = ANY($1::uuid[])`,
        [ids.slice(1), KEY]
      );
      expect(await sweeper.sweepOnce()).toMatchObject({ keysSealed: 2, keysUnsealed: 0 });
      // The row the interrupted run had sealed was not touched again.
      expect(await stored(ids[0])).toEqual(first);
      for (const id of ids) {
        expect(await stored(id)).toMatchObject({ liveKey: null, liveKeyVersion: 1 });
        await expect(lives.get(EVE, id)).resolves.toMatchObject({ key: KEY });
      }
      expect(await sweeper.sweepOnce()).toMatchObject({ keysSealed: 0, keysUnsealed: 0 });
    });

    it('WITHOUT THE SECRET: no live starts (503, nothing written), and a plaintext row stays as it is', async () => {
      const id = await legacyLive(BOB);
      delete process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
      try {
        expect(await refusal(start(ALICE))).toEqual({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'LIVE_KEY_SEALING_UNAVAILABLE',
        });
        expect(await q(`SELECT 1 FROM lives WHERE "broadcasterId" = $1`, [ALICE])).toEqual([]);
        expect(await sweeper.sweepOnce()).toMatchObject({ keysSealed: 0, keysUnsealed: 1 });
        expect(await stored(id)).toMatchObject({ liveKey: KEY, liveKeyCiphertext: null });
      } finally {
        process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = KEY_SECRET;
      }
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

    it('tells every poll HOW MANY watch - a number, never who - the broadcaster uncounted', async () => {
      const live = await start();
      await lives.get(BOB, live.id);
      const bobs = await lives.manifest(BOB, live.id);
      expect(bobs.viewers).toBe(1);
      await lives.get(CAROL, live.id);
      expect((await lives.manifest(CAROL, live.id)).viewers).toBe(2);
      // The broadcaster's KEY read (a return from the background) shows no count, so runs none.
      seats.watchingCalls = 0;
      await lives.get(ALICE, live.id);
      expect(seats.watchingCalls).toBe(0);
      // Its manifest reads the same number as the viewers', without taking a seat.
      const alices = await lives.manifest(ALICE, live.id);
      expect(alices.viewers).toBe(2);
      expect(seats.watchingCalls).toBe(1);
      expect(seats.held.size).toBe(2);
      // NO IDENTITY IN THE ANSWER: no viewer's id anywhere in what the broadcaster or a viewer reads.
      expect(JSON.stringify(bobs)).not.toContain(CAROL);
      expect(JSON.stringify(alices)).not.toContain(BOB);
      expect(JSON.stringify(alices)).not.toContain(CAROL);
      // A viewer who leaves, and one the broadcaster removes, leave the count at once.
      await lives.leave(BOB, live.id);
      expect((await lives.manifest(ALICE, live.id)).viewers).toBe(1);
      await lives.removeViewer(ALICE, live.id, CAROL);
      expect((await lives.manifest(ALICE, live.id)).viewers).toBe(0);
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

    it('takes segments from the broadcaster only, and tells nobody else the live exists', async () => {
      const live = await start();
      const absent = '22222222-2222-4222-8222-222222222222';
      // A live that exists and one that does not answer a non-broadcaster THE SAME on all three
      // write routes: an existence oracle is what a 403 here would be.
      for (const id of [live.id, absent]) {
        for (const call of [
          () => lives.ingest(BOB, id, 0, segment(0)),
          () => lives.end(BOB, id),
          () => lives.removeViewer(BOB, id, CAROL),
        ]) {
          expect(await refusal(call())).toEqual({
            status: HttpStatus.NOT_FOUND,
            code: 'LIVE_NOT_FOUND',
          });
        }
      }
      expect(store.countFor(live.id)).toBe(0);
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

  describe('the push to the followers when a live goes on air (WP-L7)', () => {
    const follow = (follower: string, followed = ALICE) =>
      q(`INSERT INTO user_follows ("followerUserId", "followedUserId") VALUES ($1, $2)`, [
        follower,
        followed,
      ]);

    it("tells the broadcaster's followers ONCE, at the first stored segment - minus a block and a removal", async () => {
      await follow(BOB);
      await follow(CAROL);
      await follow(EVE);
      await follow(DAVE, BOB); // follows somebody else: not told
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [CAROL, ALICE]);
      const live = await start();
      await lives.removeViewer(ALICE, live.id, EVE);

      // The start alone has nothing to watch: nobody is told yet.
      expect(await pushed()).toEqual([]);
      await lives.ingest(ALICE, live.id, 0, segment(0));
      expect(await pushed()).toEqual([
        {
          recipientIds: [BOB],
          type: 'live_started',
          actorId: ALICE,
          actorName: 'Alice',
          text: '',
          associationLogoMediaId: null,
          pushData: { liveId: live.id },
        },
      ]);

      // The rest of the live, a repeat of segment 0 (a lost answer retried) and a reconnect after a
      // silence are the same row, already stamped: never a second push.
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await lives.ingest(ALICE, live.id, 1, segment(1));
      await q(`UPDATE lives SET "lastSegmentAt" = now() - interval '40 seconds' WHERE id = $1`, [
        live.id,
      ]);
      await lives.ingest(ALICE, live.id, 2, segment(2));
      expect(await pushed()).toHaveLength(1);
      const [row] = await q(`SELECT "announcedAt" FROM lives WHERE id = $1`, [live.id]);
      expect(row.announcedAt).not.toBeNull();
    });

    it('tells nobody about a live ended before its first segment, nor about a refused start', async () => {
      await follow(BOB);
      const live = await start();
      await lives.end(ALICE, live.id);
      expect((await refusal(lives.ingest(ALICE, live.id, 0, segment(0)))).status).toBeGreaterThan(
        399
      );
      muted.add(ALICE);
      expect((await refusal(start())).code).toBe('LIVE_MUTED');
      expect(await pushed()).toEqual([]);
    });

    it('a NEW live is a new announcement: one push per live row, not per broadcaster', async () => {
      await follow(BOB);
      const first = await start();
      await lives.ingest(ALICE, first.id, 0, segment(0));
      await lives.end(ALICE, first.id);
      const second = await start();
      await lives.ingest(ALICE, second.id, 0, segment(0));
      expect((await pushed()).map((n) => n.pushData?.liveId)).toEqual([first.id, second.id]);
    });

    it("an association's live goes to the ASSOCIATION's followers, named and pictured as it", async () => {
      await q(`INSERT INTO associations (id, name, "logoMediaId") VALUES ($1, 'BDE', 'logo1')`, [
        ASSO,
      ]);
      await q(
        `INSERT INTO association_follows ("followerUserId", "associationId") VALUES ($1, $2), ($3, $2)`,
        [CAROL, ASSO, ALICE]
      );
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ICM', ${SE})`,
        [ASSO]
      );
      await follow(BOB); // follows the member, not the association: not told
      mayActAs.add(`${ALICE}:${ASSO}`);
      const live = await lives.start(ALICE, { key: KEY, associationId: ASSO });
      await lives.ingest(ALICE, live.id, 0, segment(0));
      expect(await pushed()).toEqual([
        {
          recipientIds: [CAROL],
          type: 'live_started',
          actorId: ALICE,
          actorName: 'BDE',
          text: '',
          associationId: ASSO,
          associationLogoMediaId: 'logo1',
          pushData: { liveId: live.id, associationId: ASSO },
        },
      ]);
    });

    it("A MEMBER'S LIVE RESPECTS SPACES AS A POST DOES: a follower sharing none is not told and cannot watch", async () => {
      await follow(BOB);
      await follow(FRANK);
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      expect((await pushed()).map((n) => n.recipientIds)).toEqual([[BOB]]);

      // The same 404 as an absent live, on every watch path: nothing says it exists.
      for (const p of [lives.get(FRANK, live.id), lives.manifest(FRANK, live.id)]) {
        expect(await refusal(p)).toEqual({ status: HttpStatus.NOT_FOUND, code: 'LIVE_NOT_FOUND' });
      }
      await expect(lives.listOpen(FRANK)).resolves.toEqual([]);
      await expect(lives.get(BOB, live.id)).resolves.toMatchObject({ key: KEY });

      // A READ GRANT opens what an ENTITY broadcasts, never what a member does - as for a post
      // (WP7): FRANK named a reader of Saint-Etienne still cannot watch ALICE.
      await q(`INSERT INTO read_grants (user_id, campus, formation) VALUES ($1, ${SE}, NULL)`, [
        FRANK,
      ]);
      expect(await refusal(lives.get(FRANK, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      await expect(lives.listOpen(FRANK)).resolves.toEqual([]);

      // Ended but still held (the purge refused): the outsider gets the 404, never the 410.
      store.failPurge = true;
      await lives.end(ALICE, live.id);
      expect(await refusal(lives.get(FRANK, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      expect((await refusal(lives.get(BOB, live.id))).code).toBe('LIVE_ENDED');
    });

    it("AN ASSOCIATION'S LIVE REACHES WHOM ITS RULES OR ITS MEMBERSHIP REACH, and a read grant watches without a push", async () => {
      await q(`INSERT INTO associations (id, name) VALUES ($1, 'BDE Gardanne')`, [ASSO]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ISMIN', ${GA})`,
        [ASSO]
      );
      await q(`INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`, [
        ASSO,
        DAVE,
      ]);
      await q(
        `INSERT INTO association_follows ("followerUserId", "associationId")
         VALUES ($1, $4), ($2, $4), ($3, $4)`,
        [BOB, DAVE, FRANK, ASSO]
      );
      // BOB is a NAMED reader of Gardanne: he may watch, and is never notified for it.
      await q(`INSERT INTO read_grants (user_id, campus, formation) VALUES ($1, ${GA}, NULL)`, [
        BOB,
      ]);
      mayActAs.add(`${ALICE}:${ASSO}`);
      const live = await lives.start(ALICE, { key: KEY, associationId: ASSO });
      await lives.ingest(ALICE, live.id, 0, segment(0));

      expect(await pushed()).toHaveLength(1);
      expect([...notices[0].recipientIds].sort()).toEqual([DAVE, FRANK]);
      for (const viewer of [DAVE, FRANK, BOB]) {
        await expect(lives.get(viewer, live.id)).resolves.toMatchObject({ key: KEY });
      }
      expect(await refusal(lives.get(CAROL, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      await expect(lives.listOpen(CAROL)).resolves.toEqual([]);
      await expect(lives.listOpen(FRANK)).resolves.toEqual([
        expect.objectContaining({ id: live.id }),
      ]);
    });

    it('REFUSES TO PUSH for a broadcaster with no name rather than title it with a user id', async () => {
      await follow(CAROL, BOB);
      const live = await start(BOB);
      await expect(lives.ingest(BOB, live.id, 0, segment(0))).resolves.toMatchObject({ index: 0 });
      expect(await pushed()).toEqual([]);
      // Claimed all the same: refused once, never retried.
      const [row] = await q(`SELECT "announcedAt" FROM lives WHERE id = $1`, [live.id]);
      expect(row.announcedAt).not.toBeNull();
    });

    it('sends nothing while LIVE_ENABLED is off, and the segment is still taken', async () => {
      await follow(BOB);
      const live = await start();
      process.env.LIVE_ENABLED = 'false';
      await expect(lives.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        index: 0,
      });
      expect(await pushed()).toEqual([]);
    });

    it('a failing announcement never fails the segment, and is not retried', async () => {
      await follow(BOB);
      let attempts = 0;
      const broken = new LivesService(
        ds,
        store,
        { mayAct: async () => false } as unknown as AssociationsService,
        { isUserMuted: async () => false } as unknown as ModerationService,
        seats as unknown as LiveSeats,
        new LiveAnnouncer(ds, {
          resolveDisplayName: async () => 'Alice',
          pushNotice: async () => {
            attempts += 1;
            throw new Error('mute lookup down');
          },
        } as unknown as PostNotificationsService),
        notifications
      );
      const live = await broken.start(ALICE, { key: KEY });
      await expect(broken.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        index: 0,
      });
      await expect(broken.ingest(ALICE, live.id, 1, segment(1))).resolves.toMatchObject({
        index: 1,
      });
      await broken.announcementsSettled();
      expect(attempts).toBe(1);
    });

    it('SEGMENT 0 DOES NOT WAIT FOR ITS ANNOUNCEMENT: the answer comes while the push is still held', async () => {
      await follow(BOB);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const held = new LivesService(
        ds,
        store,
        { mayAct: async () => false } as unknown as AssociationsService,
        { isUserMuted: async () => false } as unknown as ModerationService,
        seats as unknown as LiveSeats,
        new LiveAnnouncer(ds, {
          resolveDisplayName: async () => 'Alice',
          pushNotice: async (data: { recipientIds: string[] }) => {
            entered();
            await gate;
            return data.recipientIds.length;
          },
        } as unknown as PostNotificationsService),
        notifications
      );
      const live = await held.start(ALICE, { key: KEY });
      // Answered with the push still held inside `pushNotice`: nothing here waits for it.
      await expect(held.ingest(ALICE, live.id, 0, segment(0))).resolves.toMatchObject({
        index: 0,
      });
      await inside;
      release();
      await held.announcementsSettled();
    });

    it('reads the audience on its own: followers only, deduplicated, never the broadcaster', async () => {
      await follow(BOB);
      await follow(BOB);
      await follow(ALICE);
      const live = await start();
      expect(await q(liveAudienceSql(false), [ALICE, live.id])).toEqual([{ id: BOB }]);
    });

    it('stamps the lives that exist when the column is ADDED, so the deploy announces none of them', async () => {
      const fresh = `lives_it_mig_${Math.random().toString(36).slice(2, 10)}`;
      await admin.query(`CREATE SCHEMA ${fresh}`);
      try {
        await admin.query(`SET search_path TO ${fresh}`);
        await admin.query(MIGRATION);
        await admin.query(`INSERT INTO lives ("broadcasterId", "liveKey") VALUES ($1, $2)`, [
          ALICE,
          KEY,
        ]);
        await admin.query(ANNOUNCED_AT);
        await admin.query(ANNOUNCED_AT);
        const { rows } = await admin.query(
          `SELECT "announcedAt" = "startedAt" AS stamped FROM lives`
        );
        expect(rows).toEqual([{ stamped: true }]);
      } finally {
        await admin.query(`SET search_path TO public`);
        await admin.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
      }
    });
  });

  describe('the reservation: no pooled connection held across the store (P2-1)', () => {
    it('A STALLED STORE DOES NOT BLOCK AN UNRELATED QUERY on the same pool, even a pool of ONE', async () => {
      const one = new DataSource({
        type: 'postgres',
        url: URL,
        entities: [...LIVE_ENTITIES, ContentReport],
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
          seats as unknown as LiveSeats,
          new LiveAnnouncer(one, notifications),
          notifications
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
        // Segment 0 started an announcement on this pool: it settles before the pool goes.
        await onOne.announcementsSettled();
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
      for (const b of broadcasters) {
        ids.push((await lives.start(b, { key: KEY, acceptedRulesVersion: LIVE_RULES_VERSION })).id);
      }
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
      expect(report).toEqual({
        ended: 1,
        deleted: 1,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
      expect(store.countFor(silent.id)).toBe(0);
      await expect(lives.get(CAROL, talking.id)).resolves.toBeDefined();
      expect(store.countFor(talking.id)).toBe(1);
    });

    it('ends a live that never sent a segment within the window of its start', async () => {
      const live = await start();
      await q(`UPDATE lives SET "startedAt" = now() - interval '2 minutes' WHERE id = $1`, [
        live.id,
      ]);
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 1,
        deleted: 1,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
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
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 0,
        kept: 1,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
      expect(store.countFor(live.id)).toBe(1);

      store.failPurge = false;
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 1,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
      expect(store.objects.size).toBe(0);
      for (const table of ['lives', 'live_segments', 'live_removed_viewers']) {
        expect(await q(`SELECT 1 FROM ${table}`)).toEqual([]);
      }
      // And a second run finds nothing to do.
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 0,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
    });

    it('keeps the row while the store still lists a segment, even when the call itself answered', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      store.refuseDeletes = true;
      await lives.end(ALICE, live.id);
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 0,
        kept: 1,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
      expect(await q(`SELECT "endReason" FROM lives WHERE id = $1`, [live.id])).toEqual([
        { endReason: 'broadcaster' },
      ]);
      store.refuseDeletes = false;
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 1,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
    });

    it('never ends an open live through the purge path, whatever id reaches it', async () => {
      const live = await start();
      await lives.purgeEnded(live.id);
      await expect(lives.get(BOB, live.id)).resolves.toBeDefined();
    });
  });

  describe('moderation (WP-L8): a report, a staff cut, the first-live rules', () => {
    const MOD = '9'.repeat(64);
    const reports = () =>
      new ModerationService(ds.getRepository(ContentReport), {} as Repository<UserModeration>);
    const report = (reporterId: string, liveId: string) =>
      reports().createReport({
        reporterId,
        contentType: 'live',
        contentId: liveId,
        reason: 'spam',
      });
    /** The whole body of a refusal - `endReason` is what a screen branches on. */
    const body = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { getStatus: () => number; getResponse: () => Record<string, unknown> };
        return { status: err.getStatus(), ...err.getResponse() };
      }
      throw new Error('expected a refusal, got an answer');
    };
    const CUT = { status: HttpStatus.GONE, code: 'LIVE_ENDED', endReason: 'cut' };

    it('a viewer REPORTS a live through content_reports; once each; staff read its state', async () => {
      await q(`UPDATE users SET "displayName" = 'Alice' WHERE id = $1`, [ALICE]);
      const live = await start();
      // `reportedUserId` from the client is ignored: the broadcaster comes from the live row.
      await expect(
        reports().createReport({
          reporterId: BOB,
          contentType: 'live',
          contentId: live.id.toUpperCase(),
          reason: 'harassment',
          reportedUserId: CAROL,
        })
      ).resolves.toMatchObject({ contentId: live.id, reportedUserId: ALICE, status: 'pending' });
      expect(await refusal(report(BOB, live.id))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'ALREADY_REPORTED',
      });
      // Not in its audience (no shared space), or a block: the live API's own 404.
      expect(await refusal(report(FRANK, live.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [ALICE, DAVE]);
      expect((await refusal(report(DAVE, live.id))).code).toBe('LIVE_NOT_FOUND');

      const [row] = await reports().listAllReports();
      expect(row).toMatchObject({
        contentType: 'live',
        contentPreview: 'Alice',
        live: { state: 'open', broadcasterId: ALICE, broadcasterName: 'Alice', broadcasterCuts: 0 },
      });
    });

    it('A CUT ends the live for everyone: 410 with endReason cut, no segment, no seat, no listing', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await lives.get(BOB, live.id);
      expect(seats.held.size).toBe(1);
      await report(BOB, live.id);
      await report(CAROL, live.id);

      const cut = await lives.cut(MOD, live.id, { reason: 'harassment', details: 'note' });
      expect(cut).toMatchObject({
        liveId: live.id,
        broadcasterId: ALICE,
        reason: 'harassment',
        endReason: 'cut',
        newlyCut: true,
        priorCuts: 0,
      });

      // Purged at once: the segments, the row and every seat.
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(seats.held.size).toBe(0);
      // ...and still told apart from an ordinary end, by the cut row, to whom the live was visible.
      expect(await body(lives.get(BOB, live.id))).toMatchObject(CUT);
      expect(await body(lives.manifest(CAROL, live.id))).toMatchObject(CUT);
      expect(await body(lives.ingest(ALICE, live.id, 1, segment(1)))).toMatchObject(CUT);
      await expect(lives.end(ALICE, live.id)).resolves.toMatchObject({ endReason: 'cut' });
      await expect(lives.listOpen(BOB)).resolves.toEqual([]);
      // Nobody else learns the live existed: outside its audience, a block, another member's write.
      expect((await refusal(lives.get(FRANK, live.id))).code).toBe('LIVE_NOT_FOUND');
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [DAVE, ALICE]);
      expect((await refusal(lives.get(DAVE, live.id))).code).toBe('LIVE_NOT_FOUND');
      expect((await refusal(lives.ingest(BOB, live.id, 0, segment(0)))).code).toBe(
        'LIVE_NOT_FOUND'
      );
      expect((await refusal(lives.end(BOB, live.id))).code).toBe('LIVE_NOT_FOUND');

      // The reports it answered carry the moderator; the broadcaster has a bell row, no push.
      const handled = await q(
        `SELECT status, "reviewedBy" FROM content_reports WHERE "contentId" = $1`,
        [live.id]
      );
      expect(handled).toEqual([
        { status: 'reviewed', reviewedBy: MOD },
        { status: 'reviewed', reviewedBy: MOD },
      ]);
      expect(bell).toEqual([
        {
          recipientId: ALICE,
          type: 'live_cut',
          postId: live.id,
          actorId: '',
          actorName: '',
          text: 'harassment',
          // Pushed (WP-L8b), and its tap opens the notifications list: the live has no page left.
          pushData: { target: 'notifications' },
        },
      ]);
      const [listed] = await reports().listAllReports();
      expect(listed.live).toMatchObject({
        state: 'cut',
        cutReason: 'harassment',
        broadcasterCuts: 1,
      });

      // Idempotent: the first cut is answered again, nothing is written twice.
      await expect(lives.cut(MOD, live.id, { reason: 'spam' })).resolves.toMatchObject({
        reason: 'harassment',
        newlyCut: false,
      });
      expect(bell).toHaveLength(1);
    });

    it('answers 410 cut FROM THE ROW while a refused purge keeps it, and counts the strikes', async () => {
      store.failPurge = true;
      const first = await start();
      await lives.cut(MOD, first.id, { reason: 'spam' });
      expect(await body(lives.get(BOB, first.id))).toMatchObject(CUT);
      await expect(lives.listOpen(BOB)).resolves.toEqual([]);
      store.failPurge = false;
      // A NEW live of the same broadcaster is not blocked by the cut - only counted.
      const second = await start();
      await expect(lives.cut(MOD, second.id, { reason: 'other' })).resolves.toMatchObject({
        priorCuts: 1,
      });
    });

    it('a cut of a live ENDED BY ITS BROADCASTER records the decision and rewrites nothing - ONE answer before and after the purge, no notice', async () => {
      store.failPurge = true;
      const live = await start();
      const ended = await lives.end(ALICE, live.id);
      const ENDED = {
        status: HttpStatus.GONE,
        code: 'LIVE_ENDED',
        endReason: 'broadcaster',
        endedAt: ended.endedAt,
      };
      await expect(lives.cut(MOD, live.id, { reason: 'spam' })).resolves.toMatchObject({
        endReason: 'broadcaster',
        newlyCut: true,
      });
      expect(
        await q(`SELECT "liveEndReason", "liveEndedAt" FROM live_cuts WHERE "liveId" = $1`, [
          live.id,
        ])
      ).toEqual([{ liveEndReason: 'broadcaster', liveEndedAt: ended.endedAt }]);
      // The broadcaster ended it themselves: they are not told moderators stopped it.
      expect(bell).toEqual([]);

      // BEFORE the purge (the row is kept by the refused purge)...
      expect(await body(lives.get(BOB, live.id))).toEqual(ENDED);
      expect(await body(lives.ingest(ALICE, live.id, 1, segment(1)))).toEqual(ENDED);
      await expect(lives.end(ALICE, live.id)).resolves.toMatchObject({ endReason: 'broadcaster' });
      // ...and AFTER it, from the cut row: the same answer.
      store.failPurge = false;
      await sweeper.sweepOnce();
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(await body(lives.get(BOB, live.id))).toEqual(ENDED);
      expect(await body(lives.manifest(CAROL, live.id))).toEqual(ENDED);
      expect(await body(lives.ingest(ALICE, live.id, 1, segment(1)))).toEqual(ENDED);
      await expect(lives.end(ALICE, live.id)).resolves.toEqual({
        id: live.id,
        endedAt: ended.endedAt,
        endReason: 'broadcaster',
      });
      await expect(lives.cut(MOD, live.id, { reason: 'other' })).resolves.toMatchObject({
        endReason: 'broadcaster',
        newlyCut: false,
      });
    });

    it("a cut that ENDS the live answers cut before and after the purge, with the cut's own time", async () => {
      store.failPurge = true;
      const live = await start();
      const cut = await lives.cut(MOD, live.id, { reason: 'spam' });
      const before = await body(lives.get(BOB, live.id));
      store.failPurge = false;
      await sweeper.sweepOnce();
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      const after = await body(lives.get(BOB, live.id));
      expect(after).toEqual(before);
      expect(after).toEqual({ ...CUT, endedAt: cut.cutAt });
    });

    it('refuses a cut with no reason code, an oversized note, or no live: every refusal typed', async () => {
      const live = await start();
      expect(await refusal(lives.cut(MOD, live.id, {}))).toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: 'LIVE_CUT_REASON_INVALID',
      });
      expect((await refusal(lives.cut(MOD, live.id, { reason: 'Spam' }))).code).toBe(
        'LIVE_CUT_REASON_INVALID'
      );
      expect(
        (await refusal(lives.cut(MOD, live.id, { reason: 'spam', details: 'x'.repeat(501) }))).code
      ).toBe('LIVE_CUT_DETAILS_INVALID');
      expect(
        await refusal(lives.cut(MOD, '33333333-3333-4333-8333-333333333333', { reason: 'spam' }))
      ).toEqual({ status: HttpStatus.NOT_FOUND, code: 'LIVE_NOT_FOUND' });
      // Nothing of a refused cut is left behind: the live is still on air.
      await expect(lives.get(BOB, live.id)).resolves.toMatchObject({ id: live.id });
    });

    it('RACE: a cut during a stalled segment store answers at once; the segment gets 410 cut; nothing outlives the purge', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      const hold = store.holdNextStore();
      const ingest = body(lives.ingest(ALICE, live.id, 1, segment(1)));
      await hold.entered;

      await expect(lives.cut(MOD, live.id, { reason: 'spam' })).resolves.toMatchObject({
        endReason: 'cut',
      });
      // The purge waited for the reservation: the row is kept, ended by the cut.
      expect(await q(`SELECT "endReason" FROM lives WHERE id = $1`, [live.id])).toEqual([
        { endReason: 'cut' },
      ]);
      hold.release();
      expect(await ingest).toMatchObject(CUT);
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
    });

    it('RACE: a cut, a segment and a viewer join at once - whatever wins, nothing is served after the cut', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      const [cut, put, join] = await Promise.allSettled([
        lives.cut(MOD, live.id, { reason: 'inappropriate' }),
        lives.ingest(ALICE, live.id, 1, segment(1)),
        lives.get(BOB, live.id),
      ]);
      expect(cut.status).toBe('fulfilled');
      // Each of the two either ran BEFORE the cut (an answer) or after it (the cut's 410) - never
      // another refusal, and never a segment taken after the cut.
      const refused = [put, join].filter((o) => o.status === 'rejected');
      const bodies = await Promise.all(
        refused.map((o) => body(Promise.reject((o as PromiseRejectedResult).reason)))
      );
      expect(bodies).toEqual(bodies.map(() => expect.objectContaining(CUT)));
      await sweeper.sweepOnce();
      expect(store.countFor(live.id)).toBe(0);
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(await body(lives.get(BOB, live.id))).toMatchObject(CUT);
      expect(await body(lives.ingest(ALICE, live.id, 2, segment(2)))).toMatchObject(CUT);
    });

    it('keeps a cut 90 days (owner, 2026-10-20), then the sweep deletes it', async () => {
      const live = await start();
      await lives.cut(MOD, live.id, { reason: 'spam' });
      await q(`UPDATE live_cuts SET "cutAt" = now() - interval '89 days 23 hours'`);
      await sweeper.sweepOnce();
      expect(await q(`SELECT 1 FROM live_cuts`)).toHaveLength(1);
      await q(`UPDATE live_cuts SET "cutAt" = now() - interval '90 days'`);
      await expect(sweeper.sweepOnce()).resolves.toMatchObject({ cutsPruned: 1 });
      expect(await q(`SELECT 1 FROM live_cuts`)).toEqual([]);
    });

    it('a throw in the start prune does not skip the cut prune', async () => {
      const live = await start();
      await lives.cut(MOD, live.id, { reason: 'spam' });
      await q(`UPDATE live_cuts SET "cutAt" = now() - interval '90 days'`);
      const spy = jest.spyOn(lives, 'pruneStarts').mockRejectedValueOnce(new Error('boom'));
      try {
        await expect(sweeper.sweepOnce()).resolves.toMatchObject({ cutsPruned: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(await q(`SELECT 1 FROM live_cuts`)).toEqual([]);
    });

    it('REFUSES A START until the first-live rules are accepted, and records the acceptance', async () => {
      await q(`DELETE FROM live_rules_acceptances WHERE "userId" = $1`, [ALICE]);
      await expect(lives.rulesStatus(ALICE)).resolves.toEqual({
        version: LIVE_RULES_VERSION,
        acceptedVersion: null,
        acceptedAt: null,
      });
      for (const accepted of [
        undefined,
        null,
        0,
        LIVE_RULES_VERSION + 1,
        String(LIVE_RULES_VERSION),
      ]) {
        expect(
          await body(lives.start(ALICE, { key: KEY, acceptedRulesVersion: accepted }))
        ).toEqual({
          status: HttpStatus.FORBIDDEN,
          code: 'LIVE_RULES_NOT_ACCEPTED',
          rulesVersion: LIVE_RULES_VERSION,
        });
      }
      expect(await q(`SELECT 1 FROM lives`)).toEqual([]);

      const live = await lives.start(ALICE, { key: KEY, acceptedRulesVersion: LIVE_RULES_VERSION });
      expect(live.broadcasterId).toBe(ALICE);
      expect(await lives.rulesStatus(ALICE)).toMatchObject({ acceptedVersion: LIVE_RULES_VERSION });
      // Recorded once: the next start needs no field.
      await lives.end(ALICE, live.id);
      await expect(lives.start(ALICE, { key: KEY })).resolves.toBeDefined();
    });

    it('a muted member is refused a start before anything is recorded (the posting rule)', async () => {
      await q(`DELETE FROM live_rules_acceptances WHERE "userId" = $1`, [BOB]);
      muted.add(BOB);
      expect(
        (await refusal(lives.start(BOB, { key: KEY, acceptedRulesVersion: LIVE_RULES_VERSION })))
          .code
      ).toBe('LIVE_MUTED');
      expect(await q(`SELECT 1 FROM live_rules_acceptances WHERE "userId" = $1`, [BOB])).toEqual(
        []
      );
    });

    it('the CHECK takes cut and still refuses an unknown end reason', async () => {
      const live = await start();
      await expect(
        q(`UPDATE lives SET "endedAt" = now(), "endReason" = 'bogus' WHERE id = $1`, [live.id])
      ).rejects.toThrow(/lives_end_reason/);
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
      expect(await sweeper.sweepOnce()).toEqual({
        ended: 0,
        deleted: 1,
        kept: 0,
        orphans: 0,
        cutsPruned: 0,
        chatLinesErased: 0,
        keysSealed: 0,
        keysUnsealed: 0,
      });
      expect(store.countFor(own.id)).toBe(0);
      await expect(lives.get(BOB, other.id)).resolves.toBeDefined();
    });

    it('deletes the cuts OF the account and its rules acceptance; a cut it MADE keeps the decision', async () => {
      const MOD = '9'.repeat(64);
      const own = await start(ALICE);
      await lives.cut(MOD, own.id, { reason: 'spam' });
      const other = await start(CAROL);
      await lives.cut(ALICE, other.id, { reason: 'other' });

      await erase(ALICE);
      expect(await q(`SELECT "liveId", "reviewerId" FROM live_cuts ORDER BY "cutAt"`)).toEqual([
        { liveId: other.id, reviewerId: DELETED_ACCOUNT },
      ]);
      expect(await q(`SELECT 1 FROM live_rules_acceptances WHERE "userId" = $1`, [ALICE])).toEqual(
        []
      );
      // Idempotent.
      await expect(erase(ALICE)).resolves.toEqual({});
    });

    it("REFUSES TO CUT an erased broadcaster's live: typed, and no cut pools the erased as one offender", async () => {
      const MOD = '9'.repeat(64);
      store.failPurge = true;
      const first = await start(ALICE);
      const second = await start(CAROL);
      await erase(ALICE);
      await erase(CAROL);
      for (const live of [first, second]) {
        const refused = await lives.cut(MOD, live.id, { reason: 'spam' }).then(
          () => null,
          (e: { getStatus: () => number; getResponse: () => object }) => ({
            status: e.getStatus(),
            ...e.getResponse(),
          })
        );
        expect(refused).toMatchObject({
          status: HttpStatus.GONE,
          code: 'LIVE_ENDED',
          endReason: 'erased',
        });
      }
      expect(await q(`SELECT 1 FROM live_cuts`)).toEqual([]);
      expect(bell).toEqual([]);
      // Once purged, nothing is left to cut.
      store.failPurge = false;
      await sweeper.sweepOnce();
      expect((await refusal(lives.cut(MOD, first.id, { reason: 'spam' }))).code).toBe(
        'LIVE_NOT_FOUND'
      );
    });
  });

  describe('the live chat and floating reactions (WP-L6, migration 098)', () => {
    let chat: LiveChatService;
    beforeEach(() => {
      chat = new LiveChatService(
        ds,
        {
          isUserMuted: async (userId: string) => muted.has(userId),
        } as unknown as ModerationService,
        lives
      );
    });

    /** A sealed message as the server sees it: opaque bytes, base64 - the text never reaches it. */
    const sealed = (text: string) =>
      Buffer.from(`iv+ciphertext+tag of ${text}`.padEnd(40)).toString('base64');
    let n = 0;
    const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    /** As the controller does it: the watch rule, then the chat. */
    const say = async (who: string, liveId: string, text: string, clientId = uuid()) => {
      await lives.mayWatch(who, liveId);
      return chat.post(who, liveId, { clientId, sealed: sealed(text) });
    };
    const tap = async (
      who: string,
      liveId: string,
      counts: Record<string, number>,
      burstId = uuid()
    ) => {
      await lives.mayWatch(who, liveId);
      return chat.react(who, liveId, { burstId, counts });
    };
    /** Moves an author's rows back by SQL, relative to the database clock: no wall clock asserted. */
    const age = (table: string, column: string, who: string, ms: number) =>
      q(
        `UPDATE ${table} SET "createdAt" = "createdAt" - $2 * interval '1 millisecond' WHERE "${column}" = $1`,
        [who, ms]
      );

    it('orders messages by a server sequence, and a cursor continues exactly where it stopped', async () => {
      const live = await start();
      const first = await say(BOB, live.id, 'hello');
      expect(first).toMatchObject({ seq: 1, authorId: BOB, sealed: sealed('hello') });

      const joiner = await chat.read(CAROL, live.id, {});
      expect(joiner.messages.map((m) => m.seq)).toEqual([1]);
      expect(joiner.messagesCursor).toBe(1);

      await say(CAROL, live.id, 'hi');
      await say(ALICE, live.id, 'welcome');
      const next = await chat.read(BOB, live.id, { messagesAfter: 1, reactionsAfter: 0 });
      expect(next.messages.map((m) => m.seq)).toEqual([2, 3]);
      expect(next.messagesCursor).toBe(3);
      const idle = await chat.read(BOB, live.id, { messagesAfter: 3, reactionsAfter: 0 });
      expect(idle).toEqual({ messages: [], messagesCursor: 3, reactions: [], reactionsCursor: 0 });
    });

    it('NEVER SKIPS A MESSAGE under concurrent writers: seqs are gapless, and a poller reading meanwhile sees each once', async () => {
      const live = await start();
      const authors = [ALICE, BOB, CAROL, DAVE, EVE];
      const seen = new Map<string, number>();
      let cursor = 0;
      let writing = true;
      const poller = (async () => {
        // Polls as fast as the database answers while the writers race; then once more after.
        for (;;) {
          const done = !writing;
          const block = await chat.read(CAROL, live.id, {
            messagesAfter: cursor,
            reactionsAfter: 0,
          });
          for (const m of block.messages) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
          cursor = block.messagesCursor;
          if (done) return;
        }
      })();
      const posted = await Promise.all(
        authors.flatMap((who) => [0, 1, 2].map((i) => say(who, live.id, `${who.slice(0, 1)}${i}`)))
      );
      writing = false;
      await poller;
      expect(posted.map((m) => m.seq).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 15 }, (_, i) => i + 1)
      );
      // CAROL's own three are in her stream too (the client dedupes by clientId); each exactly once.
      expect(seen.size).toBe(15);
      expect([...seen.values()].every((count) => count === 1)).toBe(true);
    });

    it('answers a repeat with the stored message, and refuses other bytes under the same clientId', async () => {
      const live = await start();
      const id = uuid();
      const once = await say(BOB, live.id, 'same', id);
      await expect(say(BOB, live.id, 'same', id)).resolves.toEqual(once);
      expect(await refusal(say(BOB, live.id, 'different', id))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'LIVE_MESSAGE_CONFLICT',
      });
      // The same clientId from ANOTHER author is another message.
      await expect(say(CAROL, live.id, 'same', id)).resolves.toMatchObject({ seq: 2 });
    });

    it('holds 3 messages per 5 s per account, counted from its rows', async () => {
      const live = await start();
      for (const i of [1, 2, 3]) await say(BOB, live.id, `m${i}`);
      const refused = await refusal(say(BOB, live.id, 'm4'));
      expect(refused).toEqual({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'LIVE_MESSAGE_TOO_FAST',
      });
      // Another account is not slowed by BOB, and a repeat of one of BOB's is not a new message.
      await expect(say(CAROL, live.id, 'c1')).resolves.toBeDefined();
      await age('live_chat_messages', 'authorId', BOB, 5_001);
      await expect(say(BOB, live.id, 'm4')).resolves.toMatchObject({ seq: 5 });
    });

    it('refuses a muted account, and a REMOVED viewer even past the watch check (the lock re-asks)', async () => {
      const live = await start();
      muted.add(BOB);
      expect((await refusal(say(BOB, live.id, 'x'))).code).toBe('LIVE_MUTED');
      expect((await refusal(tap(BOB, live.id, { like: 1 }))).code).toBe('LIVE_MUTED');
      muted.clear();

      await lives.mayWatch(CAROL, live.id);
      await lives.removeViewer(ALICE, live.id, CAROL);
      // The removal committed between the watch check and the write: the row lock sees it.
      expect(
        await refusal(chat.post(CAROL, live.id, { clientId: uuid(), sealed: sealed('late') }))
      ).toEqual({
        status: HttpStatus.FORBIDDEN,
        code: 'LIVE_VIEWER_REMOVED',
      });
      expect(
        (await refusal(chat.react(CAROL, live.id, { burstId: uuid(), counts: { like: 1 } }))).code
      ).toBe('LIVE_VIEWER_REMOVED');
      expect((await refusal(say(CAROL, live.id, 'x'))).code).toBe('LIVE_VIEWER_REMOVED');
      // An outsider (no shared space) and a blocked viewer are the 404 of a live that does not exist.
      expect((await refusal(say(FRANK, live.id, 'x'))).code).toBe('LIVE_NOT_FOUND');
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [ALICE, DAVE]);
      expect((await refusal(say(DAVE, live.id, 'x'))).code).toBe('LIVE_NOT_FOUND');
    });

    it('ENDS WITH THE LIVE: 410 to a message after the end, and every row gone with the purge', async () => {
      const live = await start();
      await lives.ingest(ALICE, live.id, 0, segment(0));
      await say(BOB, live.id, 'bye');
      await tap(BOB, live.id, { like: 2 });
      await q(`UPDATE lives SET "endedAt" = now(), "endReason" = 'dropped' WHERE id = $1`, [
        live.id,
      ]);
      // Past the watch check: the lock refuses an end that committed first.
      expect(
        await refusal(chat.post(BOB, live.id, { clientId: uuid(), sealed: sealed('x') }))
      ).toEqual({
        status: HttpStatus.GONE,
        code: 'LIVE_ENDED',
      });
      expect((await refusal(say(BOB, live.id, 'x'))).code).toBe('LIVE_ENDED');
      expect(await sweeper.sweepOnce()).toMatchObject({ deleted: 1 });
      expect(await q(`SELECT 1 FROM live_chat_messages WHERE "liveId" = $1`, [live.id])).toEqual(
        []
      );
      expect(await q(`SELECT 1 FROM live_reaction_bursts WHERE "liveId" = $1`, [live.id])).toEqual(
        []
      );
    });

    it('HIDES a message: the ciphertext erased, a tombstone in the next poll, nothing for a late joiner', async () => {
      const live = await start();
      const bad = await say(BOB, live.id, 'insult');
      await say(CAROL, live.id, 'fine');
      const before = await chat.read(DAVE, live.id, {});
      expect(before.messagesCursor).toBe(2);

      // Neither the broadcaster nor staff: the 404 of a live that does not exist.
      expect(await refusal(chat.hide(CAROL, false, live.id, bad.id))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      await expect(chat.hide(ALICE, false, live.id, bad.id)).resolves.toEqual({
        liveId: live.id,
        messageId: bad.id,
        hidden: true,
      });
      // Idempotent, and staff may too.
      await chat.hide(EVE, true, live.id, bad.id);
      expect((await refusal(chat.hide(ALICE, false, live.id, uuid()))).code).toBe(
        'LIVE_MESSAGE_NOT_FOUND'
      );

      const [row] = await q(
        `SELECT sealed, "hiddenAt", seq FROM live_chat_messages WHERE id = $1`,
        [bad.id]
      );
      expect(row.sealed).toBeNull();
      expect(row.hiddenAt).not.toBeNull();
      expect(row.seq).toBe(3);

      const after = await chat.read(DAVE, live.id, {
        messagesAfter: before.messagesCursor,
        reactionsAfter: 0,
      });
      expect(after.messages).toEqual([{ id: bad.id, seq: 3, hidden: true }]);
      const joiner = await chat.read(EVE, live.id, {});
      expect(joiner.messages.map((m) => m.id)).not.toContain(bad.id);
      expect(joiner.messagesCursor).toBe(3);
      // The author's retry of a hidden message answers its tombstone, never a resurrection.
      await expect(
        chat.post(BOB, live.id, {
          clientId: (bad as { clientId: string }).clientId,
          sealed: sealed('insult'),
        })
      ).resolves.toEqual({ id: bad.id, seq: 3, hidden: true });
    });

    it('hides a message ON ITS LIVE only, and never after the end', async () => {
      const live = await start();
      const other = await start(CAROL);
      const onOther = await say(BOB, other.id, 'x');
      expect((await refusal(chat.hide(ALICE, false, live.id, onOther.id))).code).toBe(
        'LIVE_MESSAGE_NOT_FOUND'
      );
      await q(`UPDATE lives SET "endedAt" = now(), "endReason" = 'dropped' WHERE id = $1`, [
        other.id,
      ]);
      expect((await refusal(chat.hide(CAROL, false, other.id, onOther.id))).code).toBe(
        'LIVE_ENDED'
      );
    });

    it('filters a BLOCKED account, either way, out of my messages and my reaction sums', async () => {
      const live = await start();
      await say(BOB, live.id, 'from bob');
      await say(DAVE, live.id, 'from dave');
      const before = await chat.read(CAROL, live.id, { reactionsAfter: 0 });
      await tap(BOB, live.id, { like: 3 });
      await tap(DAVE, live.id, { like: 1 });
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [BOB, CAROL]);
      const block = await chat.read(CAROL, live.id, { reactionsAfter: before.reactionsCursor });
      expect(block.messages.map((m) => (m as { authorId: string }).authorId)).toEqual([DAVE]);
      expect(block.messagesCursor).toBe(2);
      expect(block.reactions).toEqual([{ window: expect.any(Number), counts: { like: 1 } }]);
      expect(block.reactionsCursor).toBe(2);
    });

    it('serves a late joiner the newest 50 messages and the cursor, and no reaction backlog', async () => {
      const live = await start();
      await q(
        `INSERT INTO live_chat_messages ("liveId", seq, "authorId", "clientId", sealed)
         SELECT $1, s, $2, gen_random_uuid(), decode(repeat('00', 40), 'hex')
           FROM generate_series(1, 60) s`,
        [live.id, BOB]
      );
      await q(`UPDATE lives SET "chatSeq" = 60 WHERE id = $1`, [live.id]);
      await tap(BOB, live.id, { canari: 4 });
      const joiner = await chat.read(CAROL, live.id, {});
      expect(joiner.messages.map((m) => m.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 11)
      );
      expect(joiner.messagesCursor).toBe(60);
      expect(joiner.reactions).toEqual([]);
      expect(joiner.reactionsCursor).toBe(1);
    });

    /** The whole body of a refusal: `endReason` and `retryAfterMs` ride next to the code. */
    const body = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { getStatus: () => number; getResponse: () => Record<string, unknown> };
        return { status: err.getStatus(), ...err.getResponse() };
      }
      throw new Error('expected a refusal, got an answer');
    };

    it('every chat 410 carries the end reason; a hide on a CUT then purged live answers 410 cut', async () => {
      const MOD = '9'.repeat(64);
      const dropped = await start(CAROL);
      const onDropped = await say(BOB, dropped.id, 'x');
      await q(`UPDATE lives SET "endedAt" = now(), "endReason" = 'dropped' WHERE id = $1`, [
        dropped.id,
      ]);
      const DROPPED = { status: HttpStatus.GONE, code: 'LIVE_ENDED', endReason: 'dropped' };
      expect(
        await body(chat.post(BOB, dropped.id, { clientId: uuid(), sealed: sealed('y') }))
      ).toMatchObject(DROPPED);
      expect(
        await body(chat.react(BOB, dropped.id, { burstId: uuid(), counts: { like: 1 } }))
      ).toMatchObject(DROPPED);
      expect(await body(chat.hide(CAROL, false, dropped.id, onDropped.id))).toMatchObject(DROPPED);

      store.failPurge = false;
      const live = await start();
      const said = await say(BOB, live.id, 'insult');
      await lives.cut(MOD, live.id, { reason: 'harassment' });
      const CUT = { status: HttpStatus.GONE, code: 'LIVE_ENDED', endReason: 'cut' };
      // From the row, before the purge.
      expect(await body(chat.hide(ALICE, false, live.id, said.id))).toMatchObject(CUT);
      await sweeper.sweepOnce();
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      // From WP-L8's cut record, once the row is gone: to the broadcaster and to staff...
      expect(await body(chat.hide(ALICE, false, live.id, said.id))).toMatchObject(CUT);
      expect(await body(chat.hide(EVE, true, live.id, said.id))).toMatchObject(CUT);
      // ...a viewer's late write too (the watch rule passed before the purge)...
      expect(
        await body(chat.post(BOB, live.id, { clientId: uuid(), sealed: sealed('late') }))
      ).toMatchObject(CUT);
      // ...and to anyone else the 404 of a live that does not exist.
      expect(await body(chat.hide(CAROL, false, live.id, said.id))).toMatchObject({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
    });

    it('a too fast reaction says WHEN, from the rows, as a too fast message does', async () => {
      const live = await start();
      await tap(BOB, live.id, { like: 1 });
      await tap(BOB, live.id, { like: 1 });
      await age('live_reaction_bursts', 'userId', BOB, 1_500);
      const refused = (await body(tap(BOB, live.id, { like: 1 }))) as {
        status: number;
        retryAfterMs?: number;
      };
      expect(refused).toMatchObject({ status: 429, code: 'LIVE_REACTION_TOO_FAST' });
      // The oldest burst leaves the 2 s window in ~500 ms - never the constant 2000.
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(500);
    });

    it('a late joiner gets the newest 50 VISIBLE messages: hides and blocked authors never empty it', async () => {
      const live = await start();
      await q(
        `INSERT INTO live_chat_messages ("liveId", seq, "authorId", "clientId", sealed)
         SELECT $1, s, CASE WHEN s > 70 THEN $3 ELSE $2 END, gen_random_uuid(),
                decode(repeat('00', 40), 'hex')
           FROM generate_series(1, 75) s`,
        [live.id, BOB, DAVE]
      );
      await q(`UPDATE lives SET "chatSeq" = 75 WHERE id = $1`, [live.id]);
      // The ten newest of BOB's hidden, and DAVE (the five newest of all) blocked by the joiner.
      await q(
        `UPDATE live_chat_messages SET sealed = NULL, "hiddenAt" = now()
          WHERE "liveId" = $1 AND seq BETWEEN 61 AND 70`,
        [live.id]
      );
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [CAROL, DAVE]);
      const joiner = await chat.read(CAROL, live.id, {});
      expect(joiner.messages.map((m) => m.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 11)
      );
      // The cursor is the live's top, so nothing hidden or filtered comes back as new.
      expect(joiner.messagesCursor).toBe(75);
    });

    it('AGGREGATES taps per 2 s window, leaves out my own, and holds 2 bursts / 10 taps per window', async () => {
      const live = await start();
      await tap(BOB, live.id, { like: 2, fire: 1 });
      await tap(CAROL, live.id, { like: 5 });
      await tap(DAVE, live.id, { canari: 1 });
      const sums = await chat.read(DAVE, live.id, { messagesAfter: 0, reactionsAfter: 0 });
      // One window (the live is seconds old), DAVE's own canari left out.
      expect(sums.reactions).toEqual([{ window: 0, counts: { like: 7, fire: 1 } }]);
      expect(sums.reactionsCursor).toBe(3);

      // BOB: a second burst fits, a third in the same 2 s does not; nor do taps past ten.
      await tap(BOB, live.id, { laugh: 1 });
      expect(await refusal(tap(BOB, live.id, { laugh: 1 }))).toEqual({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'LIVE_REACTION_TOO_FAST',
      });
      expect((await refusal(tap(CAROL, live.id, { like: 6 }))).code).toBe('LIVE_REACTION_TOO_FAST');
      await age('live_reaction_bursts', 'userId', BOB, 2_001);
      await expect(tap(BOB, live.id, { laugh: 1 })).resolves.toMatchObject({ seq: 5 });
    });

    it('answers a repeated burst with its seq, and refuses other counts under the same burstId', async () => {
      const live = await start();
      const id = uuid();
      const first = await tap(BOB, live.id, { like: 2, clap: 1 }, id);
      await expect(tap(BOB, live.id, { clap: 1, like: 2 }, id)).resolves.toEqual(first);
      expect((await refusal(tap(BOB, live.id, { like: 3 }, id))).code).toBe(
        'LIVE_REACTION_CONFLICT'
      );
    });

    it("an account erasure deletes the account's messages and bursts on every live", async () => {
      const live = await start();
      await say(BOB, live.id, 'mine');
      await tap(BOB, live.id, { like: 1 });
      await say(CAROL, live.id, 'hers');
      await ds.transaction((m) =>
        runErasureStatements(
          {
            write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) => (await m.query(sql, params)) as T[],
          },
          LIVES_ERASURE_STATEMENTS,
          BOB
        )
      );
      expect(await q(`SELECT 1 FROM live_chat_messages WHERE "authorId" = $1`, [BOB])).toEqual([]);
      expect(await q(`SELECT 1 FROM live_reaction_bursts WHERE "userId" = $1`, [BOB])).toEqual([]);
      expect(
        await q(`SELECT 1 FROM live_chat_messages WHERE "authorId" = $1`, [CAROL])
      ).toHaveLength(1);
    });
  });
  describe('the strike ladder (WP-L8b, migration 099): warning, suspension, withdrawal by staff', () => {
    const MOD = '9'.repeat(64);
    const reports = () =>
      new ModerationService(ds.getRepository(ContentReport), {} as Repository<UserModeration>);
    /** Starts a live of `who`, cuts it, and lets the purge take it - one abuse on record. */
    const abuse = async (who = ALICE, reason = 'spam') => {
      const live = await start(who);
      return lives.cut(MOD, live.id, { reason });
    };
    /** Moves every cut of `who` back by SQL, relative to the database clock. */
    const ageCuts = (who: string, interval: string) =>
      q(`UPDATE live_cuts SET "cutAt" = "cutAt" - $2::interval WHERE "broadcasterId" = $1`, [
        who,
        interval,
      ]);
    /** Three cuts on record: two, then the 30-day suspension run (rows moved back), then a third. */
    const threeAbuses = async (who: string) => {
      await abuse(who);
      await abuse(who);
      await ageCuts(who, '30 days');
      return abuse(who);
    };
    const body = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { getStatus: () => number; getResponse: () => Record<string, unknown> };
        return { status: err.getStatus(), ...err.getResponse() };
      }
      throw new Error('expected a refusal, got an answer');
    };

    it('the 1st cut is a WARNING: strike 1, the live_cut notice, and the next start allowed', async () => {
      const cut = await abuse();
      expect(cut).toMatchObject({
        strike: 1,
        consequence: 'warning',
        priorCuts: 0,
        standing: {
          cutsOnRecord: 1,
          suspendedUntil: null,
          withdrawnAt: null,
          withdrawalDue: false,
        },
      });
      expect(bell.map((b) => b.type)).toEqual(['live_cut']);
      await expect(start()).resolves.toBeDefined();
    });

    it('the 2nd cut SUSPENDS the right for 30 days from it: typed refusal, its own notice, then free again', async () => {
      await abuse();
      const second = await abuse(ALICE, 'harassment');
      expect(second).toMatchObject({ strike: 2, consequence: 'suspended', priorCuts: 1 });
      const until = new Date(second.cutAt.getTime() + 30 * 24 * 60 * 60_000);
      expect(second.standing.suspendedUntil).toEqual(until);
      expect(bell.map((b) => [b.type, b.text])).toEqual([
        ['live_cut', 'spam'],
        ['live_suspended', 'harassment'],
      ]);
      expect(await body(start())).toEqual({
        status: HttpStatus.FORBIDDEN,
        code: 'LIVE_BROADCAST_SUSPENDED',
        suspendedUntil: until,
      });
      await expect(lives.standing(ALICE)).resolves.toEqual({
        cutsOnRecord: 2,
        suspendedUntil: until,
        withdrawnAt: null,
      });
      // Another member is not touched by it.
      await expect(start(BOB)).resolves.toBeDefined();
      // 30 days on (the rows moved back, never a clock), the suspension has run: the start is free.
      await ageCuts(ALICE, '30 days');
      await expect(start()).resolves.toBeDefined();
    });

    it('a cut older than 90 days is FORGOTTEN by the ladder, even before the sweep prunes it', async () => {
      await abuse();
      await ageCuts(ALICE, '90 days');
      const next = await abuse();
      expect(next).toMatchObject({ strike: 1, consequence: 'warning', priorCuts: 0 });
      await expect(start()).resolves.toBeDefined();
    });

    it('the prune of an OLDER cut never lifts a suspension it helped cause: the strike is fixed on the row', async () => {
      await abuse();
      await ageCuts(ALICE, '89 days');
      await abuse();
      // The first cut passes its 90 days and the sweep deletes it; the second keeps strike 2.
      await ageCuts(ALICE, '1 day 1 hour');
      await sweeper.sweepOnce();
      expect(await q(`SELECT strike FROM live_cuts WHERE "broadcasterId" = $1`, [ALICE])).toEqual([
        { strike: 2 },
      ]);
      expect((await refusal(start())).code).toBe('LIVE_BROADCAST_SUSPENDED');
    });

    it('a cut of a live ALREADY ENDED by its broadcaster counts: strike 1 unnotified, strike 2 notified as a suspension', async () => {
      store.failPurge = true;
      const first = await start();
      await lives.end(ALICE, first.id);
      await expect(lives.cut(MOD, first.id, { reason: 'spam' })).resolves.toMatchObject({
        endReason: 'broadcaster',
        strike: 1,
      });
      expect(bell).toEqual([]);
      const second = await start();
      await lives.end(ALICE, second.id);
      await expect(lives.cut(MOD, second.id, { reason: 'other' })).resolves.toMatchObject({
        strike: 2,
        consequence: 'suspended',
      });
      expect(bell.map((b) => b.type)).toEqual(['live_suspended']);
    });

    it('a repeated cut answers its first strike and changes nothing', async () => {
      const live = await start();
      await lives.cut(MOD, live.id, { reason: 'spam' });
      await expect(lives.cut(MOD, live.id, { reason: 'other' })).resolves.toMatchObject({
        newlyCut: false,
        strike: 1,
        consequence: 'warning',
      });
      expect(bell).toHaveLength(1);
    });

    it('RACE: two cuts of two lives of one broadcaster at once take strikes 1 and 2, never 1 and 1', async () => {
      store.failPurge = true;
      const ended = await start();
      await lives.end(ALICE, ended.id);
      const open = await start();
      const both = await Promise.all([
        lives.cut(MOD, ended.id, { reason: 'spam' }),
        lives.cut(MOD, open.id, { reason: 'spam' }),
      ]);
      expect(both.map((c) => c.strike).sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it('RACE: a start and a suspending cut at once - the start either ran first or is refused', async () => {
      store.failPurge = true;
      const first = await start();
      await lives.cut(MOD, first.id, { reason: 'spam' });
      const ended = await start();
      await lives.end(ALICE, ended.id);
      const [cut, started] = await Promise.allSettled([
        lives.cut(MOD, ended.id, { reason: 'spam' }),
        lives.start(ALICE, { key: KEY }),
      ]);
      expect(cut.status).toBe('fulfilled');
      // Either the start ran first (an answer) or after the cut (the suspension) - never another
      // refusal, and never a deadlock: both take the standing lock before any row lock.
      const outcome =
        started.status === 'fulfilled'
          ? 'started'
          : ((await refusal(Promise.reject(started.reason))).code ?? '');
      expect(['started', 'LIVE_BROADCAST_SUSPENDED']).toContain(outcome);
      // Whatever the order, the NEXT start is refused: the suspension is on record.
      await q(
        `UPDATE lives SET "endedAt" = now(), "endReason" = 'broadcaster' WHERE "endedAt" IS NULL`
      );
      expect((await refusal(start())).code).toBe('LIVE_BROADCAST_SUSPENDED');
    });

    it('3 cuts on record make a withdrawal DUE; staff withdraw it, and only staff lift it', async () => {
      // Below three, the withdrawal is refused with the count.
      await abuse();
      await abuse();
      expect(await body(lives.withdraw(MOD, ALICE, { reason: 'harassment' }))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'LIVE_WITHDRAWAL_NOT_DUE',
        cutsOnRecord: 2,
        required: 3,
      });
      await ageCuts(ALICE, '30 days');
      const third = await abuse();
      expect(third).toMatchObject({
        strike: 3,
        consequence: 'suspended',
        standing: { cutsOnRecord: 3, withdrawalDue: true },
      });
      // Nothing withdraws by itself: the account is suspended, not withdrawn.
      expect(await q(`SELECT 1 FROM live_broadcast_withdrawals`)).toEqual([]);

      const withdrawn = await lives.withdraw(MOD, ALICE.toUpperCase(), {
        reason: 'harassment',
        details: 'three lives in a month',
      });
      expect(withdrawn).toMatchObject({ userId: ALICE, newlyWithdrawn: true, cutsOnRecord: 3 });
      expect(bell[bell.length - 1]).toEqual({
        recipientId: ALICE,
        type: 'live_withdrawn',
        postId: ALICE,
        actorId: '',
        actorName: '',
        text: 'harassment',
        pushData: { target: 'notifications' },
      });
      await expect(lives.withdraw(MOD, ALICE, { reason: 'spam' })).resolves.toMatchObject({
        newlyWithdrawn: false,
        reason: 'harassment',
      });
      // Past the suspension, the withdrawal alone still refuses - no clock ends it.
      await ageCuts(ALICE, '31 days');
      expect(await body(start())).toEqual({
        status: HttpStatus.FORBIDDEN,
        code: 'LIVE_BROADCAST_WITHDRAWN',
      });
      await expect(lives.liftWithdrawal(MOD, ALICE)).resolves.toEqual({
        userId: ALICE,
        lifted: true,
      });
      await expect(lives.liftWithdrawal(MOD, ALICE)).resolves.toEqual({
        userId: ALICE,
        lifted: false,
      });
      await expect(start()).resolves.toBeDefined();
    });

    it('RACE: a withdrawal against an erasure in flight never leaves a row behind it', async () => {
      await threeAbuses(CAROL);
      const erasure = ds.createQueryRunner();
      await erasure.connect();
      await erasure.startTransaction();
      try {
        await runErasureStatements(
          {
            write: async (sql, params) =>
              ((await erasure.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) =>
              (await erasure.query(sql, params)) as T[],
          },
          LIVES_ERASURE_STATEMENTS,
          CAROL
        );
        // The erasure has deleted CAROL's cuts and her (absent) withdrawal, uncommitted. The
        // withdrawal must WAIT on those cuts rather than count them and write a row the erasure's
        // DELETE has already passed.
        const withdrawal = lives.withdraw(MOD, CAROL, { reason: 'spam' }).then(
          () => 'withdrawn',
          (e: unknown) => (e as { getResponse: () => { code: string } }).getResponse().code
        );
        // A proof, not a delay: wait until PostgreSQL reports a backend waiting on a lock.
        for (;;) {
          const [{ n }] = await q(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND datname = current_database()`
          );
          if (n > 0) break;
        }
        await erasure.commitTransaction();
        expect(await withdrawal).toBe('LIVE_WITHDRAWAL_NOT_DUE');
      } finally {
        if (erasure.isTransactionActive) await erasure.rollbackTransaction();
        await erasure.release();
      }
      expect(await q(`SELECT 1 FROM live_broadcast_withdrawals`)).toEqual([]);
    });

    it('refuses a withdrawal naming the erased tombstone or with no reason code', async () => {
      expect((await refusal(lives.withdraw(MOD, DELETED_ACCOUNT, { reason: 'spam' }))).code).toBe(
        'LIVE_ACCOUNT_INVALID'
      );
      expect((await refusal(lives.withdraw(MOD, ALICE, { reason: 'nope' }))).code).toBe(
        'LIVE_CUT_REASON_INVALID'
      );
    });

    it("the queue shows a reported live's broadcaster on the ladder", async () => {
      await abuse();
      const live = await start();
      await reports().createReport({
        reporterId: BOB,
        contentType: 'live',
        contentId: live.id,
        reason: 'spam',
      });
      const [row] = await reports().listAllReports();
      expect(row.live).toMatchObject({
        broadcasterCuts: 1,
        broadcasterStanding: { cutsOnRecord: 1, suspendedUntil: null, withdrawalDue: false },
      });
    });

    it('an erasure deletes the withdrawal of the account and anonymises the one it decided', async () => {
      await threeAbuses(CAROL);
      await lives.withdraw(ALICE, CAROL, { reason: 'spam' });
      await threeAbuses(DAVE);
      await lives.withdraw(MOD, DAVE, { reason: 'spam' });
      await ds.transaction((m) =>
        runErasureStatements(
          {
            write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) => (await m.query(sql, params)) as T[],
          },
          LIVES_ERASURE_STATEMENTS,
          ALICE
        )
      );
      await ds.transaction((m) =>
        runErasureStatements(
          {
            write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) => (await m.query(sql, params)) as T[],
          },
          LIVES_ERASURE_STATEMENTS,
          DAVE
        )
      );
      expect(await q(`SELECT "userId", "reviewerId" FROM live_broadcast_withdrawals`)).toEqual([
        { userId: CAROL, reviewerId: DELETED_ACCOUNT },
      ]);
    });
  });

  describe('a reported live chat line (WP-L8b, migration 099): checked, signed, kept until handled', () => {
    const MOD = '9'.repeat(64);
    const SIGNING_KEY = 's'.repeat(40);
    const keyBefore = process.env.LIVE_REPORT_SIGNING_KEY;
    let chat: LiveChatService;
    const reports = () =>
      new ModerationService(ds.getRepository(ContentReport), {} as Repository<UserModeration>);
    let n = 0;
    const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    /** Seals `text` exactly as the client's v1 format does (`liveChatCrypto.ts`). */
    const seal = (liveId: string, clientId: string, authorId: string, text: string): string => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
      c.setAAD(liveChatAad(liveId, clientId, authorId));
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
    };
    const say = async (who: string, liveId: string, text: string) => {
      await lives.mayWatch(who, liveId);
      const clientId = uuid();
      return (await chat.post(who, liveId, {
        clientId,
        sealed: seal(liveId, clientId, who, text),
      })) as { id: string; seq: number };
    };
    const reportLine = (reporterId: string, messageId: string, message: string, liveId?: string) =>
      reports().createReport({
        reporterId,
        contentType: 'live_chat',
        contentId: messageId,
        reason: 'harassment',
        liveId,
        message,
      });
    /** The kept lines, their UTF-8 bytes decoded (the column is bytea: a NUL fits). */
    const kept = async () =>
      (
        (await q(
          `SELECT "reportId"::text, "authorId", text, seq FROM live_chat_reported_lines`
        )) as { reportId: string; authorId: string; text: Buffer; seq: number }[]
      ).map((k) => ({ ...k, text: k.text.toString('utf8') }));

    beforeEach(() => {
      process.env.LIVE_REPORT_SIGNING_KEY = SIGNING_KEY;
      chat = new LiveChatService(
        ds,
        {
          isUserMuted: async (userId: string) => muted.has(userId),
        } as unknown as ModerationService,
        lives
      );
    });
    afterAll(() => {
      if (keyBefore === undefined) delete process.env.LIVE_REPORT_SIGNING_KEY;
      else process.env.LIVE_REPORT_SIGNING_KEY = keyBefore;
    });

    it('a viewer reports a line: the text is CHECKED against the sealed line, kept with its place, and verified in the queue', async () => {
      await q(`UPDATE users SET "displayName" = 'Bob' WHERE id = $1`, [BOB]);
      const live = await start();
      const line = await say(BOB, live.id, 'une insulte 🐤');
      const report = await reportLine(CAROL, line.id.toUpperCase(), 'une insulte 🐤', live.id);
      expect(report).toMatchObject({
        contentType: 'live_chat',
        contentId: line.id,
        reportedUserId: BOB,
        status: 'pending',
      });
      expect(await kept()).toEqual([
        { reportId: report.id, authorId: BOB, text: 'une insulte 🐤', seq: line.seq },
      ]);
      const [row] = await reports().listAllReports();
      expect(row).toMatchObject({
        contentPreview: 'une insulte 🐤',
        liveChat: {
          liveId: live.id,
          messageId: line.id,
          authorId: BOB,
          authorName: 'Bob',
          text: 'une insulte 🐤',
          integrity: { content: 'verified', author: 'verified', reporter: 'verified' },
        },
      });
      // Once per reporter per line, whatever the first became.
      expect(await refusal(reportLine(CAROL, line.id, 'une insulte 🐤'))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'ALREADY_REPORTED',
      });
    });

    it('a line carrying U+0000 is reportable: kept as bytes, shown and verified as the same string', async () => {
      const live = await start();
      const withNul = 'avant\u0000apres';
      const line = await say(BOB, live.id, withNul);
      await expect(reportLine(CAROL, line.id, withNul)).resolves.toMatchObject({
        contentType: 'live_chat',
      });
      expect((await kept())[0].text).toBe(withNul);
      const [row] = await reports().listAllReports();
      expect(row.liveChat).toMatchObject({
        text: withNul,
        integrity: { content: 'verified', author: 'verified', reporter: 'verified' },
      });
    });

    it('a REMOVED viewer reports what they saw before the removal, and the live itself - never a line after it', async () => {
      const live = await start();
      const before = await say(BOB, live.id, 'avant');
      await lives.mayWatch(CAROL, live.id);
      await lives.removeViewer(ALICE, live.id, CAROL);
      const after = await say(BOB, live.id, 'apres');
      // The removal is pinned to the first line's instant: "no later than" is the boundary, and the
      // second line, written in a later transaction, is strictly after it.
      await q(
        `UPDATE live_removed_viewers SET "removedAt" =
           (SELECT "createdAt" FROM live_chat_messages WHERE id = $1)
          WHERE "liveId" = $2 AND "viewerId" = $3`,
        [before.id, live.id, CAROL]
      );

      expect(await refusal(reportLine(CAROL, after.id, 'apres'))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'LIVE_NOT_FOUND',
      });
      await expect(reportLine(CAROL, before.id, 'avant')).resolves.toMatchObject({
        contentType: 'live_chat',
        reportedUserId: BOB,
      });
      await expect(
        reports().createReport({
          reporterId: CAROL,
          contentType: 'live',
          contentId: live.id,
          reason: 'inappropriate',
        })
      ).resolves.toMatchObject({ contentType: 'live', reportedUserId: ALICE });
      // Only the removed viewer is bounded: another viewer reports the later line.
      await expect(reportLine(DAVE, after.id, 'apres')).resolves.toMatchObject({
        contentType: 'live_chat',
      });
    });

    it('THE INDEX ITSELF refuses a repeat the dedup read did not see, as ALREADY_REPORTED', async () => {
      // The dedup read is made blind, so only `content_reports_reporter_content_uniq` stands
      // between the two saves - what two requests racing past the read meet.
      const repo = ds.getRepository(ContentReport);
      const blind = Object.create(repo) as Repository<ContentReport>;
      blind.findOne = async () => null;
      const service = new ModerationService(blind, {} as Repository<UserModeration>);
      const logged = jest.spyOn(Logger.prototype, 'log');
      try {
        const live = await start();
        const report = () =>
          service.createReport({
            reporterId: CAROL,
            contentType: 'live',
            contentId: live.id,
            reason: 'spam',
          });
        await report();
        expect(await refusal(report())).toEqual({
          status: HttpStatus.CONFLICT,
          code: 'ALREADY_REPORTED',
        });
        expect(logged.mock.calls.some(([m]) => String(m).includes('refused by the index'))).toBe(
          true
        );
        expect(await q(`SELECT 1 FROM content_reports`)).toHaveLength(1);
      } finally {
        logged.mockRestore();
      }
    });

    it('RACE: the same line reported twice at once is ONE report, the other ALREADY_REPORTED', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      const both = await Promise.allSettled([
        reportLine(CAROL, line.id, 'texte'),
        reportLine(CAROL, line.id, 'texte'),
      ]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = both.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(await refusal(Promise.reject(lost.reason))).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'ALREADY_REPORTED',
      });
      expect(await kept()).toHaveLength(1);
    });

    it('two ERASED reporters of one thing do not collide on the unique index', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      await reportLine(CAROL, line.id, 'texte');
      await reportLine(DAVE, line.id, 'texte');
      await q(`UPDATE content_reports SET "reporterId" = $1`, [DELETED_ACCOUNT]);
      expect(await q(`SELECT 1 FROM content_reports`)).toHaveLength(2);
    });

    it("a LONG line - past the composer's 300 characters, within what the server stores - is reportable", async () => {
      const live = await start();
      const long = 'é'.repeat(400) + 'x'.repeat(100);
      const line = await say(BOB, live.id, long);
      await expect(reportLine(CAROL, line.id, long)).resolves.toMatchObject({
        contentType: 'live_chat',
      });
      expect((await kept())[0].text).toBe(long);
      // Past what any stored line can hold, the hand-over itself is refused, before anything is read.
      expect(await refusal(reportLine(DAVE, line.id, 'x'.repeat(901)))).toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: 'LIVE_CHAT_REPORT_MESSAGE_INVALID',
      });
    });

    it('REFUSES A TEXT THE AUTHOR DID NOT WRITE, and writes nothing', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'bonjour');
      expect(await refusal(reportLine(CAROL, line.id, 'une insulte inventée'))).toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: 'LIVE_CHAT_REPORT_MISMATCH',
      });
      // A line whose ciphertext does not open under the live key is refused the same way.
      const forged = await chat.post(BOB, live.id, {
        clientId: uuid(),
        sealed: Buffer.from('not a real seal'.padEnd(40)).toString('base64'),
      });
      expect((await refusal(reportLine(CAROL, (forged as { id: string }).id, 'x'))).code).toBe(
        'LIVE_CHAT_REPORT_MISMATCH'
      );
      expect(await q(`SELECT 1 FROM content_reports`)).toEqual([]);
      expect(await kept()).toEqual([]);
    });

    it('is no oracle: another live, no shared space, a block with the author, a hidden line - all 404 LIVE_NOT_FOUND', async () => {
      const live = await start();
      const other = await start(CAROL);
      const line = await say(BOB, live.id, 'texte');
      const notFound = { status: HttpStatus.NOT_FOUND, code: 'LIVE_NOT_FOUND' };
      expect(await refusal(reportLine(DAVE, line.id, 'texte', other.id))).toEqual(notFound);
      expect(await refusal(reportLine(FRANK, line.id, 'texte'))).toEqual(notFound);
      expect(await refusal(reportLine(DAVE, uuid(), 'texte'))).toEqual(notFound);
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [BOB, EVE]);
      expect(await refusal(reportLine(EVE, line.id, 'texte'))).toEqual(notFound);
      await chat.hide(ALICE, false, live.id, line.id);
      expect(await refusal(reportLine(DAVE, line.id, 'texte'))).toEqual(notFound);
      expect(await kept()).toEqual([]);
    });

    it('refuses 503 with no signing key, before anything is written - never a line kept unsigned', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      delete process.env.LIVE_REPORT_SIGNING_KEY;
      expect(await refusal(reportLine(CAROL, line.id, 'texte'))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'LIVE_REPORT_SIGNING_UNAVAILABLE',
      });
      expect(await q(`SELECT 1 FROM content_reports`)).toEqual([]);
    });

    it('OUTLIVES THE LIVE (the cascade stops at it) and a cut leaves its report pending', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      const report = await reportLine(CAROL, line.id, 'texte');
      await lives.cut(MOD, live.id, { reason: 'spam' });
      expect(await q(`SELECT 1 FROM lives WHERE id = $1`, [live.id])).toEqual([]);
      expect(await q(`SELECT 1 FROM live_chat_messages`)).toEqual([]);
      expect(await kept()).toHaveLength(1);
      expect(await q(`SELECT status FROM content_reports WHERE id = $1`, [report.id])).toEqual([
        { status: 'pending' },
      ]);
    });

    it('is ERASED by the sweep once its report is handled - and only then', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      const report = await reportLine(CAROL, line.id, 'texte');
      await expect(sweeper.sweepOnce()).resolves.toMatchObject({ chatLinesErased: 0 });
      expect(await kept()).toHaveLength(1);
      await reports().reviewReport(report.id, MOD, 'dismissed');
      await expect(sweeper.sweepOnce()).resolves.toMatchObject({ chatLinesErased: 1 });
      expect(await kept()).toEqual([]);
      const [row] = await reports().listAllReports();
      expect(row).toMatchObject({ status: 'dismissed', contentPreview: null, liveChat: null });
    });

    it('is ERASED at the 90-day bound even UNHANDLED; the report itself stays pending', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      const report = await reportLine(CAROL, line.id, 'texte');
      await q(`UPDATE live_chat_reported_lines SET "keptAt" = now() - interval '89 days 23 hours'`);
      await expect(sweeper.sweepOnce()).resolves.toMatchObject({ chatLinesErased: 0 });
      await q(`UPDATE live_chat_reported_lines SET "keptAt" = now() - interval '90 days'`);
      await expect(sweeper.sweepOnce()).resolves.toMatchObject({ chatLinesErased: 1 });
      expect(await kept()).toEqual([]);
      expect(await q(`SELECT status FROM content_reports WHERE id = $1`, [report.id])).toEqual([
        { status: 'pending' },
      ]);
    });

    it('a deleted report takes its line (the foreign key cascades)', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      const report = await reportLine(CAROL, line.id, 'texte');
      await q(`DELETE FROM content_reports WHERE id = $1`, [report.id]);
      expect(await kept()).toEqual([]);
    });

    it('a row ALTERED in the database reads altered; a rotated key reads key-rotated', async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      await reportLine(CAROL, line.id, 'texte');
      const integrity = async () => (await reports().listAllReports())[0].liveChat?.integrity;
      expect(await integrity()).toEqual({
        content: 'verified',
        author: 'verified',
        reporter: 'verified',
      });
      // keptAt is signed: moving it (and so the 90-day bound) reads altered.
      await q(`UPDATE live_chat_reported_lines SET "keptAt" = "keptAt" + interval '30 days'`);
      expect((await integrity())?.content).toBe('altered');
      await q(`UPDATE live_chat_reported_lines SET "keptAt" = "keptAt" - interval '30 days'`);
      expect((await integrity())?.content).toBe('verified');
      await q(`UPDATE live_chat_reported_lines SET text = convert_to('autre chose', 'UTF8')`);
      expect(await integrity()).toEqual({
        content: 'altered',
        author: 'verified',
        reporter: 'verified',
      });
      // The reporter erased and the author re-attributed: the erasure does not hide the rewrite.
      await q(`UPDATE content_reports SET "reporterId" = $1`, [DELETED_ACCOUNT]);
      await q(`UPDATE live_chat_reported_lines SET "authorId" = $1`, [DAVE]);
      expect(await integrity()).toEqual({
        content: 'altered',
        author: 'altered',
        reporter: 'erased',
      });
      process.env.LIVE_REPORT_SIGNING_KEY = 'r'.repeat(40);
      expect(await integrity()).toEqual({
        content: 'key-rotated',
        author: 'key-rotated',
        reporter: 'key-rotated',
      });
    });

    it("the AUTHOR's erasure keeps the line, anonymised, its content still verified (owner, 2026-10-20)", async () => {
      const live = await start();
      const line = await say(BOB, live.id, 'texte');
      await reportLine(CAROL, line.id, 'texte');
      const erase = () =>
        ds.transaction((m) =>
          runErasureStatements(
            {
              write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
              read: async <T>(sql: string, params: unknown[]) =>
                (await m.query(sql, params)) as T[],
            },
            LIVES_ERASURE_STATEMENTS,
            BOB
          )
        );
      await erase();
      await erase();
      expect(await q(`SELECT 1 FROM live_chat_messages WHERE "authorId" = $1`, [BOB])).toEqual([]);
      expect(await kept()).toEqual([
        expect.objectContaining({ authorId: DELETED_ACCOUNT, text: 'texte' }),
      ]);
      expect((await reports().listAllReports())[0].liveChat?.integrity).toEqual({
        content: 'verified',
        author: 'erased',
        reporter: 'verified',
      });
    });
  });

  describe('the 24 h alarm on the live report queue (WP-L8b item e)', () => {
    /** A report row, its `createdAt` moved back by SQL from the database's own `now()`. */
    const report = (contentType: string, status: string, age: string) =>
      q(
        `INSERT INTO content_reports ("reporterId", "contentType", "contentId", reason, status, "createdAt")
         VALUES ($1, $2, gen_random_uuid()::text, 'spam', $3, now() - $4::interval)`,
        [CAROL, contentType, status, age]
      );

    it('reads only the PENDING live and live_chat reports, and their age on the database clock', async () => {
      await report('live', 'pending', '10 days'); // ten days always hold more than 24 working hours
      await report('live_chat', 'pending', '0 seconds');
      await report('post', 'pending', '20 days');
      await report('live', 'reviewed', '30 days');
      await report('live_chat', 'dismissed', '30 days');

      const reading = await new LiveReportAgeScheduler(ds).reportOnce();
      expect(reading.pending).toBe(2);
      expect(reading.overdue).toBe(1);
      // The `timestamp` column read back as the instant it was written: ten days, to the minute.
      const tenDays = 10 * 24 * 3_600_000;
      expect(reading.oldestWallMs).toBeGreaterThanOrEqual(tenDays);
      expect(reading.oldestWallMs).toBeLessThan(tenDays + 60_000);
    });

    it('reads an empty queue on one row, with the clock', async () => {
      await report('post', 'pending', '20 days');
      expect(await new LiveReportAgeScheduler(ds).reportOnce()).toEqual({
        pending: 0,
        overdue: 0,
        oldestWallMs: null,
        oldestWorkingMs: null,
      });
    });
  });
});
