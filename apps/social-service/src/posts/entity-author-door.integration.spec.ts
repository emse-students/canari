/**
 * AN ENTITY'S POST BELONGS TO THE ENTITY (2026-11-14, profiles-and-access.md) - against a REAL
 * PostgreSQL. The author's door (`authorDoorHoldsSql`) opens a PERSONAL post to its writer always,
 * and a post in an entity's name to its writer only while they are still a member of that entity.
 * Every place "the author" opens or is told something asks it: the visibility predicate, the by-id
 * gate's "scheduled later, unless the reader wrote it", the comment and reaction notices to the
 * author (`postAuthorIsTold`), and the bell rows those wrote (`bellRowShownSql`).
 *
 * The cast: an association reaching (ICM, Saint-Etienne) only; `away` is its officer in Gardanne
 * (outside its audience but for the membership), `near` its officer in Saint-Etienne ICM (in its
 * audience either way), `staffAuthor` a member of staff with no space who writes a personal post.
 * Each case is read while the officer is a member, then after their membership is removed.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { EntityManager } from 'typeorm';
import { postVisibleToViewerSql } from '../spaces/reader-spaces';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import { bellRowShownSql, PostNotificationsService } from './post-notifications.service';
import {
  createBellTargetTables,
  createPostNotificationsTable,
} from './post-notifications.it-schema';
import { PostsService } from './posts.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const ICM_SE = [{ formation: 'ICM', promo: 2024 }];
const ISMIN_GA = [{ formation: 'ISMIN', promo: 2024 }];

const ASSO = '00000000-0000-4000-8000-00000000a0a1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Written by `away`, in the association's name. */
const P_AWAY = id(701);
/** Written by `near`, in the association's name, scheduled a day later. */
const P_NEAR_SCHEDULED = id(702);
/** Written by `staffAuthor` in their own name: no space, no association. */
const P_PERSONAL = id(703);
/** A live reel `away` published in the association's name. */
const R_AWAY = id(704);
/** A live reel `away` published in their own name. */
const R_AWAY_OWN = id(705);

maybe("an entity's post: the author's door follows the membership, against PostgreSQL", () => {
  const schema = `author_door_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  let manager: EntityManager;

  const q = async (sql: string, params: unknown[] = []) =>
    (await client.query(sql, params as unknown[])).rows;

  const row = async (postId: string): Promise<OpenablePost> =>
    (
      await q(
        `SELECT id, "authorId", "associationId", anonymous, "hiddenByModeration", "scheduledAt",
                kind, "expiresAt" FROM posts WHERE id = $1`,
        [postId]
      )
    )[0];

  const sees = async (postId: string, viewer: string) =>
    (
      await q(`SELECT ${postVisibleToViewerSql('posts', '$2')} AS v FROM posts WHERE id = $1`, [
        postId,
        viewer,
      ])
    )[0]?.v === true;

  const opens = async (postId: string, viewer: string) =>
    (await readPostOpenVerdict(manager, await row(postId), { viewerId: viewer }, 'READ_OR_REACT'))
      .refusal;

  const notifications = () =>
    new PostNotificationsService({} as never, { manager } as never, {} as never, {} as never);

  /** The bell rows of `recipient` that `bellRowShownSql` shows, by type. */
  const bellTypes = async (recipient: string) =>
    (
      (await q(
        `SELECT n.type FROM post_notifications n WHERE n."recipientId" = $1 AND ${bellRowShownSql('n')}
          ORDER BY n.type`,
        [recipient]
      )) as { type: string }[]
    ).map((r) => r.type);

  const leave = (who: string) =>
    q(`DELETE FROM association_members WHERE "associationId" = $1 AND "userId" = $2`, [ASSO, who]);
  const join_ = (who: string) =>
    q(`INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`, [ASSO, who]);

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, formation varchar,
        "displayName" varchar, "firstName" varchar, "lastName" varchar, posts text[] NOT NULL DEFAULT '{}');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "isBDE" boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false,
        "reachPublic" varchar(16), "reachSpaces" jsonb, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamp,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamp,
        mentions text NOT NULL DEFAULT '', comments jsonb NOT NULL DEFAULT '[]',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "durationMs" int, markdown text,
        images jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255));
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
    `);
    await createPostNotificationsTable((sql) => client.query(sql));
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '074_coorganise.sql',
      '078_read_grants.sql',
      '114_user_follow_status.sql',
      '121_member_reposts.sql',
      '132_read_grant_readers.sql',
      // The bell re-reads a birthday notice against its date (`birthdayRowShownSql`).
      '148_profile_birthdays.sql',
    ]) {
      await client.query(migration(name));
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS user_moderation ("userId" varchar(255) PRIMARY KEY, "isMuted" boolean NOT NULL DEFAULT false)`
    );
    // The bell's one statement reads its target gates' tables (`bell-row-gates.ts`).
    await createBellTargetTables((sql) => client.query(sql));
    await q(`INSERT INTO associations (id, name) VALUES ($1, 'Asso')`, [ASSO]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ICM', 'saint-etienne')`,
      [ASSO]
    );
    for (const [userId, campus, cursus] of [
      ['away', 'gardanne', ISMIN_GA],
      ['near', 'saint-etienne', ICM_SE],
      ['reader', 'saint-etienne', ICM_SE],
      ['staffAuthor', 'saint-etienne', []],
    ] as const) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        userId,
        campus,
        JSON.stringify(cursus),
      ]);
    }
    await join_('away');
    await join_('near');
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", "scheduledAt")
         VALUES ($1, 'away', $4, NULL), ($2, 'near', $4, now() + interval '1 day'), ($3, 'staffAuthor', NULL, NULL)`,
      [P_AWAY, P_NEAR_SCHEDULED, P_PERSONAL, ASSO]
    );
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", kind, "expiresAt")
         VALUES ($1, 'away', $3, 'reel', now() + interval '2 days'),
                ($2, 'away', NULL, 'reel', now() + interval '2 days')`,
      [R_AWAY, R_AWAY_OWN, ASSO]
    );
    // What the author was told while they were a member, and a mention that is not theirs as author.
    for (const [recipient, type, postId] of [
      ['away', 'comment', P_AWAY],
      ['away', 'reaction', P_AWAY],
      ['near', 'comment', P_NEAR_SCHEDULED],
      ['staffAuthor', 'comment', P_PERSONAL],
      ['staffAuthor', 'reaction', P_PERSONAL],
    ] as const) {
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
           VALUES ($1, $2, $3, 'reader', 'x')`,
        [recipient, type, postId]
      );
    }
    manager = {
      query: (sql: string, params?: unknown[]) =>
        client.query(sql, params as unknown[]).then((r) => r.rows),
    } as unknown as EntityManager;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('an officer outside the audience reads their entity post while they are a member, and not after', async () => {
    expect(await sees(P_AWAY, 'away')).toBe(true);
    expect(await opens(P_AWAY, 'away')).toBeNull();
    await leave('away');
    try {
      expect(await sees(P_AWAY, 'away')).toBe(false);
      expect(await opens(P_AWAY, 'away')).toBe('not-found');
      // The audience itself is untouched.
      expect(await sees(P_AWAY, 'reader')).toBe(true);
    } finally {
      await join_('away');
    }
  });

  it('the writer of a personal post keeps their door with no space and no membership', async () => {
    expect(await sees(P_PERSONAL, 'staffAuthor')).toBe(true);
    expect(await opens(P_PERSONAL, 'staffAuthor')).toBeNull();
    expect(await sees(P_PERSONAL, 'reader')).toBe(false);
  });

  it("a post scheduled later opens to its writer while they are a member, and is the audience's 404 after", async () => {
    // `near` stays in the audience as a reader: only the author's exemption is in question.
    expect(await opens(P_NEAR_SCHEDULED, 'near')).toBeNull();
    expect(await opens(P_NEAR_SCHEDULED, 'reader')).toBe('not-found');
    await leave('near');
    try {
      expect(await sees(P_NEAR_SCHEDULED, 'near')).toBe(true);
      expect(await opens(P_NEAR_SCHEDULED, 'near')).toBe('not-found');
    } finally {
      await join_('near');
    }
  });

  it('the author is told of a comment or a reaction: always on a personal post, on an entity post only while a member', async () => {
    expect(await notifications().postAuthorIsTold(P_PERSONAL)).toBe(true);
    expect(await notifications().postAuthorIsTold(P_AWAY)).toBe(true);
    await leave('away');
    try {
      expect(await notifications().postAuthorIsTold(P_AWAY)).toBe(false);
    } finally {
      await join_('away');
    }
  });

  it("a member's own reels (`getMyReels`, with their keys) list an entity's reel only while they are a member", async () => {
    const posts = new PostsService(
      { manager } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const listed = async () =>
      ((await posts.getMyReels('away')).reels as { id: string }[]).map((r) => r.id).sort();
    expect(await listed()).toEqual([R_AWAY, R_AWAY_OWN]);
    await leave('away');
    try {
      expect(await listed()).toEqual([R_AWAY_OWN]);
    } finally {
      await join_('away');
    }
  });

  it('the bell rows written to the author follow the same door - in the audience or not', async () => {
    expect(await bellTypes('away')).toEqual(['comment', 'reaction']);
    expect(await bellTypes('staffAuthor')).toEqual(['comment', 'reaction']);
    await leave('away');
    await leave('near');
    try {
      expect(await bellTypes('away')).toEqual([]);
      // Still a reader of the published post's audience, yet no longer its author: the author's
      // rows go. (P_NEAR_SCHEDULED is published here so only the door decides.)
      await q(`UPDATE posts SET "scheduledAt" = NULL WHERE id = $1`, [P_NEAR_SCHEDULED]);
      expect(await sees(P_NEAR_SCHEDULED, 'near')).toBe(true);
      expect(await bellTypes('near')).toEqual([]);
    } finally {
      await q(`UPDATE posts SET "scheduledAt" = now() + interval '1 day' WHERE id = $1`, [
        P_NEAR_SCHEDULED,
      ]);
      await join_('away');
      await join_('near');
    }
    expect(await bellTypes('away')).toEqual(['comment', 'reaction']);
  });
});
