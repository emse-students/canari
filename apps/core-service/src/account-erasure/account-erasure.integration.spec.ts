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
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlumniMergeService } from '../users/alumni-merge.service';
import { AlumniMergeSiteJobsService } from '../users/alumni-merge-site-jobs.service';
import type { MiconnectEditorClient } from '../users/miconnect-editor.client';
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
/** The Alumni merge case's two targets: erased while their merges' site jobs are still owed. */
const MERGE_TARGET = '0f0f0f0f-0000-4000-8000-00000000e1a5';
const RACED_TARGET = '1a1a1a1a-0000-4000-8000-00000000e1a5';
/** The close-versus-erasure interleavings: a Canari id and a MiConnect uuid per case. */
const INTERLEAVED = {
  a: {
    id: '2a2a2a2a-0000-4000-8000-00000000e1a5',
    mc: '2b2b2b2b-0000-4000-8000-00000000e1a5',
    dup: '2c2c2c2c-0000-4000-8000-00000000e1a5',
  },
  b: {
    id: '3a3a3a3a-0000-4000-8000-00000000e1a5',
    mc: '3b3b3b3b-0000-4000-8000-00000000e1a5',
    dup: '3c3c3c3c-0000-4000-8000-00000000e1a5',
  },
};

const CORE_TABLES = [
  'users',
  'user_blocks',
  'profile_changes',
  'profile_correction_requests',
  'platform_announcement_seen',
  'platform_announcements',
  'help_seen',
  'auth_sessions',
  'restore_credentials',
  'session_push_endings',
  'device_revoked_sessions',
];

maybe('account erasure queue against PostgreSQL', () => {
  const schema = `erasure_core_it_${Date.now()}`;
  let ds: DataSource;
  const axios = jest.requireMock('axios') as { delete: jest.Mock; post: jest.Mock };

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
    // `alumni_merges` is not in CORE_TABLES' copy: its migrations build it here.
    for (const file of [
      '028_alumni_link_and_merges.sql',
      '029_alumni_merge_marks.sql',
      '030_alumni_merge_extension.sql',
    ]) {
      await ds.query(readFileSync(join(__dirname, '..', 'migrations', file), 'utf8'));
    }
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
      await ds.query(
        `INSERT INTO users (id, "displayName", "miconnectUuid") VALUES ($1, 'Somebody', $2)`,
        [id, `mc-${id.slice(0, 8)}`]
      );
      // Two Alumni merges INTO the account made while it had no Canari account: no "targetUserId",
      // found by its MiConnect uuid (D48). One CLOSED, one still OPEN (waiting for MiConnect).
      await ds.query(
        `INSERT INTO alumni_merges
           ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", held, "completedAt")
         VALUES ('admin', $1, 'alumni-1', $3, '{}'::jsonb, now()),
                ('admin', $2, 'alumni-2', $3, '{}'::jsonb, NULL)`,
        [`closed-${id.slice(0, 8)}`, `open-${id.slice(0, 8)}`, `mc-${id.slice(0, 8)}`]
      );
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
    // The first-time helps both accounts have seen (migration 019).
    for (const id of [SUBJECT, OTHER]) {
      await ds.query(`INSERT INTO help_seen (user_id, help_id) VALUES ($1, 'welcome-tour')`, [id]);
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
    expect(await count(`help_seen WHERE user_id = $1`, [SUBJECT])).toBe(0);
    expect(await count(`help_seen WHERE user_id = $1`, [OTHER])).toBe(1);
    // The closed merge is gone; the open one stays with the target blanked, so the duplicate's own
    // erasure still runs once MiConnect merges.
    const merges = (dup: string) => count(`alumni_merges WHERE "duplicateUuid" = $1`, [dup]);
    expect(
      await count(`alumni_merges WHERE "targetUuid" = $1`, [`mc-${SUBJECT.slice(0, 8)}`])
    ).toBe(0);
    expect(await merges(`closed-${SUBJECT.slice(0, 8)}`)).toBe(0);
    expect(
      await count(`alumni_merges WHERE "duplicateUuid" = $1 AND "targetUuid" = '[deleted]'`, [
        `open-${SUBJECT.slice(0, 8)}`,
      ])
    ).toBe(1);
    expect(await count(`alumni_merges WHERE "targetUuid" = $1`, [`mc-${OTHER.slice(0, 8)}`])).toBe(
      2
    );
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

  /**
   * D54, migration 030: a target erased while its merge's sibling-site jobs are still owed. NOTHING
   * CASCADES to a job - the jobs a site settled go with the merge's history, every job still owed
   * becomes an `erase` of the duplicate's account there - and an open merge into it loses the reason
   * with the target's identifiers.
   */
  it("a target's erasure turns its merge's owed site jobs into erases, and never cascades them", async () => {
    axios.delete = jest.fn(async () => ({ data: { ok: true } }));
    const service = new AccountErasureService(ds);
    await ds.query(
      `INSERT INTO users (id, "displayName", "miconnectUuid") VALUES ($1, 'Target', $2)`,
      [MERGE_TARGET, 'mc-merge-target']
    );
    const [closed] = await ds.query(
      `INSERT INTO alumni_merges
         ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held, mode,
          reason, "duplicateSubject", "targetSubject", "markedAt", "completedAt", "completedBy")
       VALUES ('admin', 'dup-closed', 'alumni-31', 'mc-merge-target', $1, '{}'::jsonb, 'manual',
               'Her married name, confirmed by e-mail.', 'sub-dup', 'sub-target', now(), now(), 'push')
       RETURNING id`,
      [MERGE_TARGET]
    );
    await ds.query(
      `INSERT INTO alumni_merges
         ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held, mode, reason)
       VALUES ('admin', 'dup-open', 'alumni-32', 'mc-merge-target', $1, '{}'::jsonb, 'manual',
               'Names the target: a reason is personal data.')`,
      [MERGE_TARGET]
    );
    await ds.query(
      `INSERT INTO alumni_merge_site_jobs
         ("mergeId", site, "duplicateSubject", "targetSubject", "completedAt", outcome, "blockedAt", "unreadySince")
       VALUES ($1, 'sky', 'sub-dup', 'sub-target', now(), 'absent', NULL, NULL),
              ($1, 'migallery', 'sub-dup', 'sub-target', NULL, NULL, NULL, now()),
              ($1, 'le-cercle', 'sub-dup', 'sub-target', NULL, NULL, now(), NULL)`,
      [closed.id]
    );

    await service.requestErasure(MERGE_TARGET);

    // The settled job went with the merge's history; the two still owed stand, now erases.
    expect(
      await count(`alumni_merge_site_jobs WHERE site = 'sky' AND "duplicateSubject" = 'sub-dup'`)
    ).toBe(0);
    const owed = await ds.query(
      `SELECT site, kind, "mergeId", "targetSubject", "blockedAt", "unreadySince", attempts
         FROM alumni_merge_site_jobs WHERE "duplicateSubject" = 'sub-dup' ORDER BY site`
    );
    expect(owed).toEqual([
      {
        site: 'le-cercle',
        kind: 'erase',
        mergeId: null,
        targetSubject: null,
        blockedAt: null,
        unreadySince: null,
        attempts: 0,
      },
      {
        site: 'migallery',
        kind: 'erase',
        mergeId: null,
        targetSubject: null,
        blockedAt: null,
        unreadySince: null,
        attempts: 0,
      },
    ]);
    expect(await count(`alumni_merges WHERE id = $1`, [closed.id])).toBe(0);
    // The open merge keeps its row, the target and the REASON blanked.
    expect(
      await ds.query(
        `SELECT "targetUuid", "targetUserId", "targetSubject", reason FROM alumni_merges WHERE "duplicateUuid" = 'dup-open'`
      )
    ).toEqual([{ targetUuid: '[deleted]', targetUserId: null, targetSubject: null, reason: null }]);

    // The schema itself never cascades: deleting a merge row only nulls its jobs' merge.
    const [fk] = await ds.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'alumni_merge_site_jobs'::regclass AND contype = 'f'`
    );
    expect(fk.confdeltype).toBe('n');
    // ...and a transfer always names its target, an erase never does.
    await expect(
      ds.query(
        `INSERT INTO alumni_merge_site_jobs (site, kind, "duplicateSubject", "targetSubject")
         VALUES ('sky', 'transfer', 'sub-x', NULL)`
      )
    ).rejects.toThrow(/CHK_alumni_merge_site_jobs_kind/);
  }, 60_000);

  it('a call in flight when its target is erased settles nothing, and the erase it became runs next', async () => {
    const saved = { key: process.env.HANDOFF_SIGNING_KEY, url: process.env.FRONTEND_URL };
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    process.env.HANDOFF_SIGNING_KEY = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    process.env.FRONTEND_URL = 'https://canari.example';
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');
    warn.mockClear();
    log.mockClear();
    try {
      axios.delete = jest.fn(async () => ({ data: { ok: true } }));
      const erasure = new AccountErasureService(ds);
      const siteJobs = new AlumniMergeSiteJobsService(ds);
      await ds.query(
        `INSERT INTO users (id, "displayName", "miconnectUuid") VALUES ($1, 'Raced', $2)`,
        [RACED_TARGET, 'mc-raced-target']
      );
      const [merge] = await ds.query(
        `INSERT INTO alumni_merges
           ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held,
            "duplicateSubject", "targetSubject", "markedAt", "completedAt", "completedBy")
         VALUES ('admin', 'dup-raced', 'alumni-33', 'mc-raced-target', $1, '{}'::jsonb,
                 'sub-raced', 'sub-raced-target', now(), now(), 'push')
         RETURNING id`,
        [RACED_TARGET]
      );
      await ds.manager.transaction((m) =>
        siteJobs.writeJobs(m, merge.id, 'sub-raced', 'sub-raced-target')
      );
      // Only Sky's job is due: every other job of this table waits.
      await ds.query(
        `UPDATE alumni_merge_site_jobs SET "nextAttemptAt" = now() + interval '1 hour'
          WHERE NOT ("duplicateSubject" = 'sub-raced' AND site = 'sky')`
      );

      // Sky's transfer is in flight when the target is erased, and Sky answers it transferred.
      axios.post = jest.fn(async () => {
        if (axios.post.mock.calls.length > 1) return { status: 200, data: { outcome: 'absent' } };
        await erasure.requestErasure(RACED_TARGET);
        return { status: 200, data: { outcome: 'transferred' } };
      });
      await siteJobs.drain();
      // The transfer's answer is not recorded on the job it no longer is - the EXPECTED race, at
      // info, with ONE warning naming the site and the job, since that transfer had landed...
      expect(log).toHaveBeenCalledWith(expect.stringContaining('became an erase during the call'));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/site=sky job=\S+ transferred/));
      expect(error).not.toHaveBeenCalled();
      // ...and the conversion KEPT the claimed job's lease (GREATEST): nothing ran it a second time
      // under the call. Once due, the erases run, naming no target.
      expect(axios.post).toHaveBeenCalledTimes(1);
      await ds.query(
        `UPDATE alumni_merge_site_jobs SET "nextAttemptAt" = now() WHERE "duplicateSubject" = 'sub-raced'`
      );
      await siteJobs.drain();
      const ops = (
        axios.post.mock.calls as [string, unknown, { headers: { authorization: string } }][]
      ).map(([, , config]) =>
        JSON.parse(Buffer.from(config.headers.authorization.split('.')[1], 'base64url').toString())
      );
      // (The erasure made all three of the merge's owed jobs due at once: each ran as an erase.)
      expect(ops[0]).toEqual(
        expect.objectContaining({ aud: 'sky', mode: 'transfer', target: 'sub-raced-target' })
      );
      expect(
        ops
          .slice(1)
          .map((c) => [c.aud, c.mode, 'target' in c])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).toEqual([
        ['le-cercle', 'erase', false],
        ['migallery', 'erase', false],
        ['sky', 'erase', false],
      ]);
      // Done, an erase leaves no row: no merge is left to show it.
      expect(await count(`alumni_merge_site_jobs WHERE "duplicateSubject" = 'sub-raced'`)).toBe(0);
    } finally {
      error.mockRestore();
      // `process.env.X = undefined` would store the STRING "undefined": an unset one is deleted.
      for (const [name, value] of [
        ['HANDOFF_SIGNING_KEY', saved.key],
        ['FRONTEND_URL', saved.url],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);

  /**
   * THE CLOSE AND THE TARGET'S ERASURE, interleaved both ways, through the real
   * `AlumniMergeService.completeFromPush` (MiConnect scripted) and the real erasure: neither order may
   * leave a TRANSFER onto an erased person. `hook` runs the erasure at the interleaving's point.
   */
  async function interleave(
    c: { id: string; mc: string; dup: string },
    sub: string,
    hook: 'before-close' | 'during-close'
  ): Promise<{ mergeId: string; erasure: Promise<void> | null }> {
    axios.delete = jest.fn(async () => ({ data: { ok: true } }));
    const erasure = new AccountErasureService(ds);
    // The request's OWN transaction is under test: its drain would run core's statements a second
    // time and heal a broken order after the fact, hiding the race this case exists to catch.
    erasure.drain = async () => undefined;
    const realJobs = new AlumniMergeSiteJobsService(ds);
    await ds.query(`INSERT INTO users (id, "displayName", "miconnectUuid") VALUES ($1, 'T', $2)`, [
      c.id,
      c.mc,
    ]);
    const [merge] = await ds.query(
      `INSERT INTO alumni_merges
         ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held,
          "duplicateSubject", "targetSubject", "markedAt")
       VALUES ('admin', $1, 'alumni-77', $2, $3, '{}'::jsonb, $4, $5, now())
       RETURNING id`,
      [c.dup, c.mc, c.id, sub, `${sub}-target`]
    );
    let running: Promise<void> | null = null;
    const editor = {
      assertAvailable: () => ({ baseUrl: 'https://mc', token: 't' }),
      userByUuid: async (uuid: string) => (uuid === c.dup ? null : { pk: 7 }),
      sourceLinksOf: async () => {
        // (A) The erasure COMMITS after the merge was read and proven, before the close.
        if (hook === 'before-close') await erasure.requestErasure(c.id);
        return [{ slug: 'alumni', identifier: '77' }];
      },
    };
    const siteJobs = {
      writeJobs: async (
        m: Parameters<AlumniMergeSiteJobsService['writeJobs']>[0],
        ...rest: [string, string, string | null]
      ) => {
        if (hook === 'during-close') {
          // (B) The close holds the merge row (its UPDATE ran); the erasure starts now and must
          // WAIT on that row - proven by its backend waiting on a lock, not by a delay.
          running = erasure.requestErasure(c.id);
          for (let i = 0; ; i++) {
            const [w] = await ds.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%alumni_merges%' AND pid <> pg_backend_pid()`
            );
            if (w.n > 0) break;
            if (i > 500) throw new Error('the erasure never waited on the closing merge row');
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        return realJobs.writeJobs(m, ...rest);
      },
      drain: async () => undefined,
    };
    const service = new AlumniMergeService(
      ds,
      editor as unknown as MiconnectEditorClient,
      { requestErasure: async () => undefined } as unknown as AccountErasureService,
      siteJobs as unknown as AlumniMergeSiteJobsService
    );
    await service.completeFromPush(c.dup, c.mc, merge.id);
    return { mergeId: merge.id, erasure: running };
  }

  it('(A) the target erased between the read and the close: the close reads it blanked and writes erases', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const { mergeId } = await interleave(INTERLEAVED.a, 'sub-ia', 'before-close');
    expect(
      await ds.query(
        `SELECT site, kind, "mergeId", "targetSubject" FROM alumni_merge_site_jobs
          WHERE "duplicateSubject" = 'sub-ia' ORDER BY site`
      )
    ).toEqual(
      ['le-cercle', 'migallery', 'sky'].map((site) => ({
        site,
        kind: 'erase',
        mergeId,
        targetSubject: null,
      }))
    );
    const [row] = await ds.query(
      `SELECT "completedAt", "targetUuid" FROM alumni_merges WHERE id = $1`,
      [mergeId]
    );
    expect(row.completedAt).not.toBeNull();
    expect(row.targetUuid).toBe('[deleted]');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('target was erased meanwhile'));
  }, 60_000);

  it('(B) the close commits while the erasure waits on its row: the erasure sees it and converts its jobs', async () => {
    const { erasure } = await interleave(INTERLEAVED.b, 'sub-ib', 'during-close');
    await erasure;
    // The closed merge went with the target's history; its jobs stand, every one an erase.
    expect(await count(`alumni_merges WHERE "duplicateUuid" = $1`, [INTERLEAVED.b.dup])).toBe(0);
    expect(
      await ds.query(
        `SELECT site, kind, "mergeId", "targetSubject" FROM alumni_merge_site_jobs
          WHERE "duplicateSubject" = 'sub-ib' ORDER BY site`
      )
    ).toEqual(
      ['le-cercle', 'migallery', 'sky'].map((site) => ({
        site,
        kind: 'erase',
        mergeId: null,
        targetSubject: null,
      }))
    );
  }, 60_000);
});
