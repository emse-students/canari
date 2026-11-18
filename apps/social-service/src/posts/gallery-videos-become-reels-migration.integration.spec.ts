/**
 * Held migration 176 (owner, 2026-11-14: "Toute vidéo verticale et/ou inférieure à 90 s est un
 * CanaReel, y compris depuis la galerie" - and for the videos already posted, "Oui, toutes") against a
 * REAL PostgreSQL: every post whose ONLY content is one video becomes a reel expiring one year after
 * its publication, with no declared length; a post with several media, a poll, a form, an attached
 * form, a linked event or a later schedule stays a post; a reel and a replay are untouched; the
 * widened `posts_kind_shape` still refuses every other shape; a second run changes nothing; and the
 * documented rollback finds exactly the converted rows.
 *
 * GATED on `SOCIAL_IT_DATABASE_URL` like every integration file (CI's `test-social-integration`
 * fails on a skipped test); the checks of the file's own text run everywhere.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://admin:password@localhost:5432/auth_db bun run test -- gallery-videos-become-reels
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { REEL_RETENTION_DAYS } from './reel.constants';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '176_gallery_videos_become_reels.sql'),
  'utf8'
);
const STATEMENT = MIGRATION.slice(MIGRATION.indexOf('UPDATE posts p\n'));

/** The `AND` / `WHERE` lines of the UPDATE: the allowlist, one condition each. */
const allowlist = STATEMENT.split('\n')
  .map((line) => line.trim())
  .filter((line) => /^(WHERE|AND) /.test(line))
  .map((line) => line.replace(/^(WHERE|AND) /, '').replace(/;$/, ''));

describe('migration 176 - the file itself', () => {
  it('is HELD for the owner: the marker opens the file', () => {
    expect(MIGRATION.split('\n')[0]).toMatch(/^-- canari:hold-for-owner - DESTRUCTIVE/);
  });

  it('writes the year a new reel gets by default', () => {
    expect(STATEMENT).toContain(`"publishedAt" + interval '${REEL_RETENTION_DAYS} days'`);
  });

  it('converts posts only, never a reel or a replay, and leaves the length undeclared', () => {
    expect(allowlist[0]).toBe("p.kind = 'post'");
    expect(STATEMENT).not.toMatch(/replay/);
    expect(STATEMENT).not.toMatch(/"durationMs"/);
  });

  it('documents a counts query with the SAME allowlist as the statement', () => {
    const header = MIGRATION.slice(0, MIGRATION.indexOf('SET lock_timeout'));
    expect(allowlist.length).toBeGreaterThanOrEqual(8);
    for (const condition of allowlist) {
      expect(header).toContain(condition);
    }
    expect(header).toMatch(/GROUP BY 1 ORDER BY 1;/);
  });
});

maybe('migration 176 against PostgreSQL', () => {
  const schema = `gallery_reels_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const VIDEO = { type: 'video', mimeType: 'video/mp4', mediaId: 'm', width: 1920, height: 1080 };
  const PHOTO = { type: 'image', mimeType: 'image/jpeg', mediaId: 'i' };
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ids = {
    recentVideo: id(1),
    oldVideo: id(2),
    mimeOnlyVideo: id(3),
    videoAndPhoto: id(4),
    photo: id(5),
    videoWithPoll: id(6),
    videoWithForm: id(7),
    videoWithEvent: id(8),
    scheduledVideo: id(9),
    reel: id(10),
    replay: id(11),
    text: id(12),
    videoWithAttachedForm: id(13),
    videoTypeNoMime: id(14),
    imageTypeVideoMime: id(15),
  };

  const row = async (rowId: string) => {
    const { rows } = await client.query<{
      kind: string;
      durationMs: number | null;
      e: string | null;
      due: string | null;
    }>(
      `SELECT kind, "durationMs",
              to_char("expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS e,
              to_char(("publishedAt" + interval '365 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS due
         FROM posts WHERE id = $1`,
      [rowId]
    );
    return rows[0];
  };

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The columns the statement reads, and migration 156's constraint as production has it.
    await client.query(`CREATE TABLE posts (
      id uuid PRIMARY KEY, kind varchar(16) NOT NULL DEFAULT 'post',
      images jsonb NOT NULL DEFAULT '[]', polls jsonb NOT NULL DEFAULT '[]',
      forms jsonb NOT NULL DEFAULT '[]', "attachedFormId" uuid NULL,
      "linkedCalendarEventId" uuid NULL, "liveId" uuid NULL,
      "durationMs" integer NULL, "expiresAt" timestamptz NULL,
      "publishedAt" timestamptz NOT NULL DEFAULT now())`);
    await client.query(`ALTER TABLE posts ADD CONSTRAINT posts_kind_shape CHECK (
      (kind = 'post' AND "durationMs" IS NULL AND "expiresAt" IS NULL AND "liveId" IS NULL)
      OR (kind = 'reel' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL
          AND "liveId" IS NULL)
      OR (kind = 'replay' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL
          AND "liveId" IS NOT NULL))`);
    const post = (
      rowId: string,
      fields: Partial<{
        images: unknown[];
        polls: unknown[];
        forms: unknown[];
        attachedFormId: string;
        linkedCalendarEventId: string;
        publishedAt: string;
      }>
    ) =>
      client.query(
        `INSERT INTO posts (id, images, polls, forms, "attachedFormId", "linkedCalendarEventId", "publishedAt")
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, date_trunc('second', now()) - interval '10 days'))`,
        [
          rowId,
          JSON.stringify(fields.images ?? []),
          JSON.stringify(fields.polls ?? []),
          JSON.stringify(fields.forms ?? []),
          fields.attachedFormId ?? null,
          fields.linkedCalendarEventId ?? null,
          fields.publishedAt ?? null,
        ]
      );
    await post(ids.recentVideo, { images: [VIDEO] });
    await post(ids.oldVideo, { images: [VIDEO], publishedAt: '2024-01-01T00:00:00Z' });
    await post(ids.mimeOnlyVideo, { images: [{ mimeType: 'VIDEO/quicktime', mediaId: 'q' }] });
    await post(ids.videoAndPhoto, { images: [VIDEO, PHOTO] });
    await post(ids.photo, { images: [PHOTO] });
    await post(ids.videoWithPoll, { images: [VIDEO], polls: [{ id: 'p' }] });
    await post(ids.videoWithForm, { images: [VIDEO], forms: [{ id: 'f' }] });
    await post(ids.videoWithEvent, { images: [VIDEO], linkedCalendarEventId: id(99) });
    await post(ids.videoWithAttachedForm, { images: [VIDEO], attachedFormId: id(98) });
    await post(ids.scheduledVideo, { images: [VIDEO], publishedAt: '2099-01-01T00:00:00Z' });
    await post(ids.text, {});
    // The create door asks both a `video` type and a `video/*` mimeType: a row with the type and no
    // video mimeType, or a video mimeType under another type, is not a video it would take.
    await post(ids.videoTypeNoMime, { images: [{ type: 'video', mediaId: 'n' }] });
    await post(ids.imageTypeVideoMime, {
      images: [{ type: 'image', mimeType: 'video/mp4', mediaId: 'v' }],
    });
    await client.query(
      `INSERT INTO posts (id, kind, images, "durationMs", "expiresAt") VALUES ($1, 'reel', $2, 30000, '2027-01-01T00:00:00Z')`,
      [ids.reel, JSON.stringify([VIDEO])]
    );
    await client.query(
      `INSERT INTO posts (id, kind, images, "durationMs", "expiresAt", "liveId") VALUES ($1, 'replay', $2, 30000, '2026-12-01T00:00:00Z', $3)`,
      [ids.replay, JSON.stringify([VIDEO]), id(97)]
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('converts every published single-video post to a reel due one year after its publication', async () => {
    await client.query(MIGRATION);

    for (const converted of [ids.recentVideo, ids.oldVideo, ids.mimeOnlyVideo]) {
      const r = await row(converted);
      expect(r.kind).toBe('reel');
      expect(r.durationMs).toBeNull();
      expect(r.e).toBe(r.due);
    }
    // A video published before the year is already due: the worker's next tick deletes it.
    const { rows } = await client.query<{ due: boolean }>(
      `SELECT "expiresAt" <= now() AS due FROM posts WHERE id = $1`,
      [ids.oldVideo]
    );
    expect(rows[0].due).toBe(true);
  });

  it('leaves every other post, the reel and the replay as they were', async () => {
    for (const kept of [
      ids.videoAndPhoto,
      ids.photo,
      ids.videoWithPoll,
      ids.videoWithForm,
      ids.videoWithEvent,
      ids.videoWithAttachedForm,
      ids.scheduledVideo,
      ids.text,
      ids.videoTypeNoMime,
      ids.imageTypeVideoMime,
    ]) {
      const r = await row(kept);
      expect([kept, r.kind, r.e]).toEqual([kept, 'post', null]);
    }
    expect(await row(ids.reel)).toMatchObject({ kind: 'reel', durationMs: 30000 });
    expect(await row(ids.replay)).toMatchObject({ kind: 'replay', durationMs: 30000 });
  });

  it('widens the constraint by a NULL reel length and nothing else', async () => {
    const refused = [
      `INSERT INTO posts (id, kind, "durationMs") VALUES ('${id(50)}', 'post', 1000)`,
      `INSERT INTO posts (id, kind, "expiresAt") VALUES ('${id(51)}', 'reel', NULL)`,
      `INSERT INTO posts (id, kind, "durationMs", "expiresAt") VALUES ('${id(52)}', 'reel', 0, now())`,
      `INSERT INTO posts (id, kind, "expiresAt", "liveId") VALUES ('${id(53)}', 'replay', now(), '${id(96)}')`,
    ];
    for (const sql of refused) {
      await expect(client.query(sql)).rejects.toThrow(/posts_kind_shape/);
    }
  });

  it('changes nothing on a second run (a deploy that fails midway re-runs the file)', async () => {
    const snapshot = await client.query(`SELECT id, kind, "expiresAt" FROM posts ORDER BY id`);
    await client.query(MIGRATION);
    const again = await client.query(`SELECT id, kind, "expiresAt" FROM posts ORDER BY id`);
    expect(again.rows).toEqual(snapshot.rows);
  });

  it('the documented rollback finds exactly the converted rows', async () => {
    const rollback =
      /--   (UPDATE posts SET kind = 'post', "expiresAt" = NULL)\n--    (WHERE kind = 'reel' AND "durationMs" IS NULL;)/.exec(
        MIGRATION
      );
    expect(rollback).not.toBeNull();
    await client.query(`${rollback![1]} ${rollback![2]}`);
    for (const back of [ids.recentVideo, ids.oldVideo, ids.mimeOnlyVideo]) {
      expect(await row(back)).toMatchObject({ kind: 'post', e: null });
    }
    expect(await row(ids.reel)).toMatchObject({ kind: 'reel' });
  });
});
