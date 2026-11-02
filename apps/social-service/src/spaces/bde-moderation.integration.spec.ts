/**
 * THE SCOPE OF A BDE MODERATOR (owner, 2026-11-02), against a REAL PostgreSQL - migrations 071 and
 * 072 for the spaces, hand-made minimal tables for the rest.
 *
 * `bde-moderation.ts` decides what a BDE `MODERATE` holder may act on: an association's post or live
 * when the association is reached by a space it governs, a person's when that person belongs to one
 * of its spaces, a report by what it is about. The unit specs give these answers as fixtures; this
 * file proves the SQL itself.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL` like `bde.integration.spec.ts`; everything happens in a throwaway
 * schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  BDE_MODERATED_POST_IDS_SQL,
  BDE_MODERATED_USER_IDS_SQL,
  BDE_MODERATES_LIVE_SQL,
  BDE_MODERATES_REPORT_SQL,
  reportInBdeScopeSql,
} from './bde-moderation';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const { MODERATE, VALIDATE_EVENTS } = AssociationPermissionFlag;

const A = {
  bdeSe: '00000000-0000-4000-8000-0000000000b1', // BDE of ICM x saint-etienne (071)
  bdeGa: '00000000-0000-4000-8000-0000000000b2', // BDE of ICM and ISMIN x gardanne
  clubSe: '00000000-0000-4000-8000-0000000000c1', // rule (ICM, saint-etienne)
  clubGa: '00000000-0000-4000-8000-0000000000c2', // rule (NULL, gardanne)
  clubNone: '00000000-0000-4000-8000-0000000000c4', // no rule: governed by nobody
} as const;

const P = {
  clubSePost: '10000000-0000-4000-8000-000000000001',
  clubGaPost: '10000000-0000-4000-8000-000000000002',
  clubNonePost: '10000000-0000-4000-8000-000000000003',
  seStudentPost: '10000000-0000-4000-8000-000000000004',
  gaStudentPost: '10000000-0000-4000-8000-000000000005',
  staffPost: '10000000-0000-4000-8000-000000000006',
} as const;

const L = {
  seLive: '20000000-0000-4000-8000-000000000001', // personal, by seStudent
  gaAssoLive: '20000000-0000-4000-8000-000000000002', // clubGa's
  cutSeLive: '20000000-0000-4000-8000-000000000003', // purged, only its cut is left
} as const;

maybe('BDE moderation scope against PostgreSQL', () => {
  const schema = `bdemod_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  const posts = async (moderator: string) =>
    (await client.query(BDE_MODERATED_POST_IDS_SQL, [moderator, Object.values(P)])).rows
      .map((r) => r.id as string)
      .sort();

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions integer NOT NULL DEFAULT 0);
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "associationId" uuid NOT NULL);
      CREATE TABLE users (id varchar(255) PRIMARY KEY, campus varchar, cursus jsonb);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255), "associationId" uuid,
        comments jsonb);
      CREATE TABLE lives (id uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
      CREATE TABLE live_cuts ("liveId" uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
      CREATE TABLE content_reports (id uuid PRIMARY KEY, "contentType" varchar(30) NOT NULL,
        "contentId" varchar NOT NULL);
      CREATE TABLE live_chat_reported_lines ("reportId" uuid PRIMARY KEY, "liveId" uuid NOT NULL);
    `);
    for (const [key, id] of Object.entries(A)) {
      await client.query(`INSERT INTO associations (id, name, "isBDE") VALUES ($1, $2, $3)`, [
        id,
        key,
        key === 'bdeSe',
      ]);
    }
    await client.query(migration('071_spaces.sql'));
    await client.query(migration('072_drop_is_bde.sql'));
    await client.query(`DELETE FROM association_audiences`);
    const rules: [string, string | null, string][] = [
      [A.bdeSe, 'ICM', 'saint-etienne'],
      [A.bdeGa, 'ICM', 'gardanne'],
      [A.clubSe, 'ICM', 'saint-etienne'],
      [A.clubGa, null, 'gardanne'],
    ];
    for (const [asso, formation, campus] of rules) {
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [asso, formation, campus]
      );
    }
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'gardanne' AND formation IN ('ISMIN', 'ICM')`,
      [A.bdeGa]
    );
    const members: [string, string, number][] = [
      ['seMod', A.bdeSe, MODERATE],
      ['gaMod', A.bdeGa, MODERATE],
      ['seVal', A.bdeSe, VALIDATE_EVENTS], // another BDE flag: moderates nothing
      ['clubMod', A.clubSe, MODERATE], // MODERATE in a mere club: inert
    ];
    for (const [userId, asso, permissions] of members) {
      await client.query(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, $2, $3)`,
        [asso, userId, permissions]
      );
    }
    const users: [string, string | null, unknown][] = [
      ['seStudent', 'saint-etienne', [{ formation: 'ICM', promo: 2027 }]],
      ['gaStudent', 'gardanne', [{ formation: 'ISMIN', promo: 2027 }]],
      ['staff', 'saint-etienne', []], // a campus and no cursus: no space
      ['seMod', 'saint-etienne', [{ formation: 'ICM', promo: 2026 }]],
      ['gaMod', 'gardanne', [{ formation: 'ICM', promo: 2026 }]],
    ];
    for (const [id, campus, cursus] of users) {
      await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        campus,
        JSON.stringify(cursus),
      ]);
    }
    const postRows: [string, string, string | null, unknown[]][] = [
      [P.clubSePost, 'seStudent', A.clubSe, [{ id: 'cm-se', userId: 'gaStudent' }]],
      [P.clubGaPost, 'gaStudent', A.clubGa, []],
      [P.clubNonePost, 'seStudent', A.clubNone, []],
      [P.seStudentPost, 'seStudent', null, []],
      [P.gaStudentPost, 'gaStudent', null, [{ id: 'cm-ga', userId: 'seStudent' }]],
      [P.staffPost, 'staff', null, []],
    ];
    for (const [id, author, asso, comments] of postRows) {
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId", comments) VALUES ($1, $2, $3, $4)`,
        [id, author, asso, JSON.stringify(comments)]
      );
    }
    await client.query(`INSERT INTO lives VALUES ($1, 'seStudent', NULL), ($2, 'gaStudent', $3)`, [
      L.seLive,
      L.gaAssoLive,
      A.clubGa,
    ]);
    await client.query(`INSERT INTO live_cuts VALUES ($1, 'seStudent', NULL)`, [L.cutSeLive]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('a BDE moderates the posts of its governed spaces, association and personal alike', async () => {
    expect(await posts('seMod')).toEqual([P.clubSePost, P.seStudentPost].sort());
    expect(await posts('gaMod')).toEqual([P.clubGaPost, P.gaStudentPost].sort());
  });

  it('leaves an association with no rule and a person with no space to the platform admin', async () => {
    for (const who of ['seMod', 'gaMod']) {
      const mine = await posts(who);
      expect(mine).not.toContain(P.clubNonePost);
      expect(mine).not.toContain(P.staffPost);
    }
  });

  it('grants nothing to another BDE flag, nor to MODERATE held in a mere club', async () => {
    expect(await posts('seVal')).toEqual([]);
    expect(await posts('clubMod')).toEqual([]);
  });

  it('scopes people: a BDE moderates the members of its spaces only', async () => {
    const users = async (moderator: string) =>
      (
        await client.query(BDE_MODERATED_USER_IDS_SQL, [
          moderator,
          ['seStudent', 'gaStudent', 'staff'],
        ])
      ).rows
        .map((r) => r.id as string)
        .sort();
    expect(await users('seMod')).toEqual(['seStudent']);
    expect(await users('gaMod')).toEqual(['gaStudent']);
  });

  it('scopes lives, reading the cut once the live row is gone', async () => {
    const live = async (moderator: string, id: string) =>
      (await client.query(BDE_MODERATES_LIVE_SQL, [moderator, id])).rows[0].moderates as boolean;
    expect(await live('seMod', L.seLive)).toBe(true);
    expect(await live('seMod', L.gaAssoLive)).toBe(false);
    expect(await live('gaMod', L.gaAssoLive)).toBe(true);
    expect(await live('seMod', L.cutSeLive)).toBe(true);
    expect(await live('gaMod', L.cutSeLive)).toBe(false);
  });

  it('narrows the report queue by what each report is about', async () => {
    const reports: [string, string, string][] = [
      ['30000000-0000-4000-8000-000000000001', 'post', P.seStudentPost],
      ['30000000-0000-4000-8000-000000000002', 'post', P.gaStudentPost],
      // A comment is judged by its post: cm-ga, written by seStudent, sits under gaStudent's post.
      ['30000000-0000-4000-8000-000000000003', 'comment', 'cm-ga'],
      ['30000000-0000-4000-8000-000000000004', 'comment', 'cm-se'],
      ['30000000-0000-4000-8000-000000000005', 'user', 'seStudent'],
      ['30000000-0000-4000-8000-000000000006', 'live', L.gaAssoLive],
      ['30000000-0000-4000-8000-000000000007', 'live_chat', 'msg-1'],
      ['30000000-0000-4000-8000-000000000008', 'post', '10000000-0000-4000-8000-0000000000ff'],
    ];
    for (const [id, type, contentId] of reports) {
      await client.query(
        `INSERT INTO content_reports (id, "contentType", "contentId") VALUES ($1, $2, $3)`,
        [id, type, contentId]
      );
    }
    await client.query(`INSERT INTO live_chat_reported_lines VALUES ($1, $2)`, [
      reports[6][0],
      L.seLive,
    ]);
    const queue = async (moderator: string) =>
      (
        await client.query(
          `SELECT r.id FROM content_reports r WHERE ${reportInBdeScopeSql('r', '$1')} ORDER BY r.id`,
          [moderator]
        )
      ).rows.map((r) => (r.id as string).slice(-1));
    // A report whose post is gone (8) is the platform admin's.
    expect(await queue('seMod')).toEqual(['1', '4', '5', '7']);
    expect(await queue('gaMod')).toEqual(['2', '3', '6']);
    const one = async (moderator: string, id: string) =>
      (await client.query(BDE_MODERATES_REPORT_SQL, [moderator, id])).rows[0].moderates as boolean;
    expect(await one('seMod', reports[0][0])).toBe(true);
    expect(await one('seMod', reports[1][0])).toBe(false);
  });
});
