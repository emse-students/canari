/**
 * THE ERASURE QUEUE AGAINST A REAL POSTGRESQL, through a real TypeORM DataSource - the claim's
 * `FOR UPDATE SKIP LOCKED`, the partial unique index, the `[rows, count]` shape TypeORM answers an
 * `UPDATE ... RETURNING` with, and the final pass, none of which a scripted mock can vouch for.
 *
 * GATED ON `CORE_IT_DATABASE_URL`: CI provides no database here, so the file reports as skipped
 * rather than passing. It needs a database that HAS core's schema (a local estate's): each table is
 * copied into a throwaway schema with `LIKE public.<table>`, migration 012 creates the queue there,
 * and the schema is dropped at the end. Downstream services are mocked (axios).
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- account-erasure.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccountErasureService } from './account-erasure.service';
import { subjectDigest } from './erasure-policy';

jest.mock('axios');

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** A UUID, because `platform_announcement_seen.user_id` is one. */
const SUBJECT = '0a0a0a0a-0000-4000-8000-00000000e1a5';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000e1a5';
/** The restore case's three accounts: erased after the archive, back with a new account, owed. */
const RESTORED = '0c0c0c0c-0000-4000-8000-00000000e1a5';
const RETURNER = '0d0d0d0d-0000-4000-8000-00000000e1a5';
const OWED = '0e0e0e0e-0000-4000-8000-00000000e1a5';

const CORE_TABLES = [
  'users',
  'user_blocks',
  'profile_changes',
  'profile_correction_requests',
  'platform_announcement_seen',
  'platform_announcements',
  'auth_sessions',
  'restore_credentials',
  'session_push_endings',
];

maybe('account erasure queue against PostgreSQL', () => {
  const schema = `erasure_core_it_${Date.now()}`;
  let ds: DataSource;
  const axios = jest.requireMock('axios') as { delete: jest.Mock };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of CORE_TABLES) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
    }
    await admin.destroy();

    ds = new DataSource({
      type: 'postgres',
      url: URL,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.query(
      readFileSync(join(__dirname, '..', 'migrations', '012_account_erasure_jobs.sql'), 'utf8')
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const [row] = await ds.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
    return row.n;
  }

  it('deactivates at once, retries a failing service, completes after the final pass', async () => {
    for (const id of [SUBJECT, OTHER]) {
      await ds.query(`INSERT INTO users (id, "displayName") VALUES ($1, 'Somebody')`, [id]);
      await ds.query(
        `INSERT INTO auth_sessions (id, "userId", "tokenId", "expiresAt")
         VALUES (gen_random_uuid(), $1, gen_random_uuid(), now() + interval '1 day')`,
        [id]
      );
      await ds.query(
        `INSERT INTO profile_changes ("userId", "actorId", "after") VALUES ($1, $1, '{}'::jsonb)`,
        [id]
      );
      // A restore key (WP-RESTORE-1): erased by its own account column, not left to a cascade.
      await ds.query(
        `INSERT INTO restore_credentials (id, "userId", "sessionId", "publicKey", "cloudBackup")
         VALUES ($1, $2, gen_random_uuid(), decode('00', 'hex'), true)`,
        [`key-${id}`, id]
      );
    }
    await ds.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [
      OTHER,
      SUBJECT,
    ]);
    // The erased account was the admin who edited somebody else: that row is the other person's.
    await ds.query(
      `INSERT INTO profile_changes ("userId", "actorId", "after") VALUES ($1, $2, '{}'::jsonb)`,
      [OTHER, SUBJECT]
    );

    // Social is down for the first attempt; the others answer.
    axios.delete = jest.fn(async (url: string) => {
      if (url.includes('social') && axios.delete.mock.calls.length <= 3) {
        throw Object.assign(new Error('down'), { response: { status: 503 } });
      }
      return { data: { ok: true } };
    });

    const service = new AccountErasureService(ds);
    await service.requestErasure(SUBJECT);
    await service.drain();

    // Deactivated at once: no user row, no session, no profile trail, no block.
    expect(await count(`users WHERE id = $1`, [SUBJECT])).toBe(0);
    expect(await count(`auth_sessions WHERE "userId" = $1`, [SUBJECT])).toBe(0);
    expect(await count(`restore_credentials WHERE "userId" = $1`, [SUBJECT])).toBe(0);
    expect(await count(`restore_credentials WHERE "userId" = $1`, [OTHER])).toBe(1);
    expect(await count(`profile_changes WHERE "userId" = $1 OR "actorId" = $1`, [SUBJECT])).toBe(0);
    expect(await count(`user_blocks`)).toBe(0);
    // ...and the other account untouched, its history kept without the erased admin's id.
    expect(await count(`users WHERE id = $1`, [OTHER])).toBe(1);
    expect(
      await count(`profile_changes WHERE "userId" = $1 AND "actorId" = '[deleted]'`, [OTHER])
    ).toBe(1);
    expect(await service.erasureState(SUBJECT)).toBe('pending');

    // A second request (an old token replaying DELETE /users/me) adds nothing.
    await service.requestErasure(SUBJECT);
    expect(await count(`account_erasure_jobs`)).toBe(4);

    const jobs = await ds.query(
      `SELECT service, attempts, "lastError", "completedAt" FROM account_erasure_jobs ORDER BY service`
    );
    expect(jobs.map((j: { service: string; attempts: number }) => [j.service, j.attempts])).toEqual(
      [
        ['chat-delivery', 0],
        ['core', 0],
        ['media', 0],
        ['social', 1],
      ]
    );
    // Media waits for social: it would delete the media of the posts social keeps for an association.
    expect(axios.delete.mock.calls.some(([url]: [string]) => url.includes('media'))).toBe(false);
    // Chat-delivery waits for social too: social's removals record seat evictions there.
    expect(axios.delete.mock.calls.some(([url]: [string]) => url.includes('chat-delivery'))).toBe(
      false
    );
    // Nobody completes before every token of the account has expired.
    expect(jobs.every((j: { completedAt: Date | null }) => j.completedAt === null)).toBe(true);

    // A job that failed PERMANENT once stays so while it keeps failing: the sign-in message does not
    // flip back to "wait" because the next failure happened to be a 503.
    await ds.query(
      `UPDATE account_erasure_jobs SET "lastFailureKind" = 'permanent', "nextAttemptAt" = now()
        WHERE service = 'social'`
    );
    expect(await service.erasureState(SUBJECT)).toBe('blocked');
    axios.delete = jest.fn(async () => {
      throw Object.assign(new Error('down'), { response: { status: 503 } });
    });
    await service.drain();
    const [social] = await ds.query(
      `SELECT attempts, "lastFailureKind" FROM account_erasure_jobs WHERE service = 'social'`
    );
    expect(social).toEqual({ attempts: 2, lastFailureKind: 'permanent' });
    axios.delete = jest.fn(async () => ({ data: { ok: true } }));

    // Time passes: the tokens expire and every job is due again.
    await ds.query(
      `UPDATE account_erasure_jobs SET "credentialsExpireAt" = now() - interval '1 second',
                                       "nextAttemptAt" = now()`
    );
    await service.drain();

    const done = await ds.query(`SELECT "subjectId", "completedAt" FROM account_erasure_jobs`);
    expect(done).toHaveLength(4);
    for (const j of done) {
      expect(j.completedAt).not.toBeNull();
      expect(j.subjectId).toMatch(/^sha256:/);
    }
    expect(await service.erasureState(SUBJECT)).toBe('none');
    expect(await service.report()).toEqual({ pending: 0, blocked: 0, overdue: 0, completed24h: 4 });
  }, 60_000);

  it('a restore erases again what the archive predates, and keeps the new account of a person who came back', async () => {
    axios.delete = jest.fn(async () => ({ data: { ok: true } }));
    const service = new AccountErasureService(ds);
    // The journal of the database about to be replaced: RESTORED and RETURNER erased two days ago
    // (complete), OWED still pending.
    for (const id of [RESTORED, RETURNER]) {
      await ds.query(
        `INSERT INTO account_erasure_jobs ("subjectId", service, "requestedAt", "credentialsExpireAt", "completedAt")
         VALUES ($1, 'core', now() - interval '2 days', now() - interval '2 days', now() - interval '1 day')`,
        [subjectDigest(id)]
      );
    }
    await ds.query(
      `INSERT INTO account_erasure_jobs ("subjectId", service, "credentialsExpireAt")
       VALUES ($1, 'social', now())`,
      [OWED]
    );
    const journal = await service.exportJournal();

    // The restore: the archive's journal knows none of it, and its users table holds RESTORED and
    // OWED as they were a month ago, and RETURNER's NEW account, opened after the erasure.
    await ds.query(`DELETE FROM account_erasure_jobs`);
    for (const id of [RESTORED, OWED]) {
      await ds.query(
        `INSERT INTO users (id, "displayName", "createdAt") VALUES ($1, 'Restored', now() - interval '30 days')`,
        [id]
      );
    }
    await ds.query(`INSERT INTO users (id, "displayName") VALUES ($1, 'Back again')`, [RETURNER]);

    const replay = await service.replayAfterRestore(journal);
    await service.drain();
    expect(replay).toEqual({
      candidates: 3,
      replayed: 2,
      keptNewer: 1,
    });
    expect(await count(`users WHERE id = ANY($1)`, [[RESTORED, OWED]])).toBe(0);
    expect(await count(`users WHERE id = $1`, [RETURNER])).toBe(1);
    expect(await service.erasureState(RESTORED)).not.toBe('none');
    expect(await service.erasureState(OWED)).not.toBe('none');
    expect(await service.erasureState(RETURNER)).toBe('none');

    // Idempotent: a second run (a restore re-run with the same export) adds nothing.
    const jobs = await count(`account_erasure_jobs`);
    await service.replayAfterRestore(journal);
    await service.drain();
    expect(await count(`account_erasure_jobs`)).toBe(jobs);
  }, 60_000);
});
