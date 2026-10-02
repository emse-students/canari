/**
 * The reel worker's SQL and migration 069, against a REAL PostgreSQL.
 *
 * `reel-retention.scheduler.spec.ts` proves the logic against a fake that interprets the worker's
 * statements - which proves nothing about the statements. This file is where the `WHERE` clauses
 * and the CHECK constraint meet a database: a due reel is selected, a non-reel and a live reel are
 * not, the cascade really removes the row and its notifications in one transaction, the migration
 * re-applies without error, and nothing that existed before it becomes a reel.
 *
 * GATED, DELIBERATELY, ON `SOCIAL_IT_DATABASE_URL`: CI does not provide a database here, and a
 * suite that fails without one would be a suite people learn to skip. The gate is visible - the
 * whole file reports as skipped, never as passing - and a developer (or the next session) runs it
 * against the local estate:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://admin:password@localhost:5432/auth_db bun run test -- reel-retention.integration
 *
 * Everything happens in a throwaway schema, dropped at the end, so it never touches a real table.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { Logger } from '@nestjs/common';
import { ReelRetentionScheduler } from './reel-retention.scheduler';
import type { ReelPurgeOutcome } from '../internal/reel-media';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '069_posts_reels.sql'), 'utf8');

maybe('reel worker against PostgreSQL (migration 069 included)', () => {
  const schema = `reel_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  /** Mimics TypeORM's postgres `query()`: rows for a SELECT, `[rows, rowCount]` for a DELETE. */
  const adapter = () => {
    const manager = {
      query: async (sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params);
        return /^\s*(DELETE|UPDATE)/i.test(sql) ? [res.rows, res.rowCount] : res.rows;
      },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        await client.query('BEGIN');
        try {
          const out = await fn(manager);
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      },
    };
    return manager;
  };

  const blobs = new Map<string, string>();
  const failing = new Set<string>();
  const retention = {
    purgeReelBlobs: async (items: Array<{ mediaId: string; ownerId: string }>) => {
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
      return out;
    },
  };

  const scheduler = () =>
    new ReelRetentionScheduler(
      { manager: adapter() } as never,
      retention as never,
      { deleteByPattern: () => Promise.resolve(0) } as never
    );

  const insertReel = async (
    id: string,
    expiresSql: string,
    media: string,
    comments: unknown[] = []
  ) =>
    client.query(
      `INSERT INTO posts (id, "authorId", markdown, images, comments, kind, "durationMs", "expiresAt")
       VALUES ($1, 'alice', '', $2::jsonb, $3::jsonb, 'reel', 30000, ${expiresSql})`,
      [id, JSON.stringify([{ mediaId: media }]), JSON.stringify(comments)]
    );

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The minimal shape the migration and the worker touch - the ORM owns the rest in real life.
    await client.query(`CREATE TABLE posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "authorId" varchar NOT NULL,
      markdown text NOT NULL DEFAULT '', images jsonb NOT NULL DEFAULT '[]',
      comments jsonb NOT NULL DEFAULT '[]', "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await client.query(
      `CREATE TABLE post_notifications (id serial PRIMARY KEY, "postId" varchar NOT NULL)`
    );
    // A row that predates the migration: it must come out of it a plain post.
    await client.query(
      `INSERT INTO posts (id, "authorId", markdown) VALUES ('00000000-0000-4000-8000-000000000001', 'old', 'before reels')`
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
    jest.restoreAllMocks();
  });

  it('applies twice without error (a deploy that fails midway re-runs the file)', async () => {
    await client.query(MIGRATION);
    await expect(client.query(MIGRATION)).resolves.toBeDefined();
  });

  it('turns NOTHING that existed into a reel', async () => {
    const { rows } = await client.query(`SELECT kind, "durationMs", "expiresAt" FROM posts`);
    expect(rows).toEqual([{ kind: 'post', durationMs: null, expiresAt: null }]);
  });

  it('refuses a row that states the reel fact in pieces', async () => {
    const bad = (sql: string) => client.query(sql);
    // a reel with no expiry would never be deleted
    await expect(
      bad(`INSERT INTO posts ("authorId", kind, "durationMs") VALUES ('a', 'reel', 1000)`)
    ).rejects.toThrow(/posts_kind_shape/);
    // a reel with no duration
    await expect(
      bad(`INSERT INTO posts ("authorId", kind, "expiresAt") VALUES ('a', 'reel', now())`)
    ).rejects.toThrow(/posts_kind_shape/);
    // a post carrying a reel's expiry would be read as expired by every reader
    await expect(
      bad(`INSERT INTO posts ("authorId", kind, "expiresAt") VALUES ('a', 'post', now())`)
    ).rejects.toThrow(/posts_kind_shape/);
    // an unknown kind
    await expect(bad(`INSERT INTO posts ("authorId", kind) VALUES ('a', 'story')`)).rejects.toThrow(
      /posts_kind_shape/
    );
  });

  it('deletes ONLY the due reel - row, notifications and every blob - and leaves the rest', async () => {
    const due = '10000000-0000-4000-8000-000000000001';
    const live = '10000000-0000-4000-8000-000000000002';
    const post = '10000000-0000-4000-8000-000000000003';
    await insertReel(due, `now() - interval '1 minute'`, 'blob-due', [
      { id: 'c1', userId: 'bob', media: { mediaId: 'blob-comment' } },
    ]);
    await insertReel(live, `now() + interval '29 days'`, 'blob-live');
    await client.query(
      `INSERT INTO posts (id, "authorId", markdown) VALUES ($1, 'carol', 'post')`,
      [post]
    );
    for (const [id, owner] of [
      ['blob-due', 'alice'],
      ['blob-comment', 'bob'],
      ['blob-live', 'alice'],
    ]) {
      blobs.set(id, owner);
    }
    await client.query(`INSERT INTO post_notifications ("postId") VALUES ($1), ($1), ($2)`, [
      due,
      live,
    ]);

    const report = await scheduler().purgeOnce();

    expect(report).toMatchObject({ due: 1, deleted: 1, failed: 0 });
    const ids = (await client.query(`SELECT id FROM posts ORDER BY id`)).rows.map((r) => r.id);
    expect(ids).toEqual(['00000000-0000-4000-8000-000000000001', live, post]);
    const notes = (await client.query(`SELECT "postId" FROM post_notifications`)).rows;
    expect(notes).toEqual([{ postId: live }]);
    expect([...blobs.keys()]).toEqual(['blob-live']);
  });

  it('is idempotent: a second run finds nothing', async () => {
    const report = await scheduler().purgeOnce();
    expect(report).toMatchObject({ due: 0, deleted: 0, failed: 0 });
  });

  it('keeps a reel whose blob fails, finishes the others, and completes it once the store recovers', async () => {
    const ids = [1, 2, 3].map((n) => `20000000-0000-4000-8000-00000000000${n}`);
    for (const [i, id] of ids.entries()) {
      await insertReel(id, `now() - interval '${i + 1} minutes'`, `blob-${i}`);
      blobs.set(`blob-${i}`, 'alice');
    }
    failing.add('blob-1');

    const first = await scheduler().purgeOnce();
    expect(first).toMatchObject({ due: 3, deleted: 2, failed: 1 });
    const left = (
      await client.query(`SELECT id FROM posts WHERE kind = 'reel' AND id = ANY($1)`, [ids])
    ).rows;
    expect(left).toEqual([{ id: ids[1] }]);

    failing.clear();
    const second = await scheduler().purgeOnce();
    expect(second).toMatchObject({ due: 1, deleted: 1, failed: 0 });
  });

  it('rolls the notifications back with the row when the transaction cannot finish', async () => {
    const id = '30000000-0000-4000-8000-000000000001';
    await insertReel(id, `now() - interval '1 minute'`, 'blob-tx');
    blobs.set('blob-tx', 'alice');
    await client.query(`INSERT INTO post_notifications ("postId") VALUES ($1)`, [id]);

    // The row delete fails inside the transaction (a lock timeout, a dropped connection).
    const real = adapter();
    const failingManager = {
      ...real,
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        real.transaction((tx) =>
          fn({
            query: (sql: string, params?: unknown[]) =>
              sql.trim().startsWith('DELETE FROM posts')
                ? Promise.reject(new Error('lock timeout'))
                : (tx as typeof real).query(sql, params),
          })
        ),
    };
    const s = new ReelRetentionScheduler(
      { manager: failingManager } as never,
      retention as never,
      { deleteByPattern: () => Promise.resolve(0) } as never
    );

    const report = await s.purgeOnce();

    expect(report).toMatchObject({ due: 1, deleted: 0, failed: 1 });
    // Nothing half-deleted: the notification is still there beside its row.
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM post_notifications WHERE "postId" = $1`,
          [id]
        )
      ).rows[0].n
    ).toBe(1);
    expect(
      (await client.query(`SELECT count(*)::int AS n FROM posts WHERE id = $1`, [id])).rows[0].n
    ).toBe(1);
    // And the next run, with the database healthy, completes it from the row alone.
    expect(await scheduler().purgeOnce()).toMatchObject({ due: 1, deleted: 1 });
  });
});
