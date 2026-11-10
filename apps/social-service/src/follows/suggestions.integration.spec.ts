/**
 * FOLLOW SUGGESTIONS (engagement WP-5) against a REAL PostgreSQL: migration 155 as it ships, every
 * exclusion of decision 2, every face rule of decision 4, L10's ranking, the entity source, the
 * dismissal and the erasure statement (docs/wiki/engagement.md, "Follow suggestions - the query").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- suggestions.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { SuggestionsService, SUGGESTION_DISMISS_INVALID } from './suggestions.service';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import { REVIEW_COHORT_ENV } from '../review-cohort';
import {
  createNotificationPreferenceTable,
  turnSuggestionsOn,
} from '../posts/post-notifications.it-schema';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const icm = (promo: number) => [{ formation: 'ICM', promo }];
const ismin = (promo: number) => [{ formation: 'ISMIN', promo }];

/**
 * The cast. `v` is the viewer: Saint-Etienne, ICM, promo 2025. Ids are readable on purpose, and
 * their ORDER matters where two scores tie (L10: ties broken by id).
 */
const USERS: Record<string, { campus: string | null; cursus: unknown; promo: number | null }> = {
  v: { campus: SE, cursus: icm(2025), promo: 2025 },
  // Accounts v follows, accepted, in Gardanne so they rank by no cohort tier of their own.
  f1: { campus: GA, cursus: ismin(2024), promo: 2024 },
  f2: { campus: GA, cursus: ismin(2024), promo: 2024 },
  f3: { campus: GA, cursus: ismin(2024), promo: 2024 },
  f4: { campus: GA, cursus: ismin(2024), promo: 2024 },
  // v follows f5 (accepted) but a block stands between them: never counted, never a face.
  f5: { campus: GA, cursus: ismin(2024), promo: 2024 },
  // v only ASKED f6: not a follow, never counted, never a face.
  f6: { campus: GA, cursus: ismin(2024), promo: 2024 },
  // Followed by f1..f6 (accepted): mutual 4 (f1..f4), faces f1, f2, f3.
  c1: { campus: GA, cursus: ismin(2024), promo: 2024 },
  // Followed by f1 with a PENDING request only: no friend-of-friend link, no other source.
  c2: { campus: GA, cursus: ismin(2024), promo: 2024 },
  // A co-member of v's association: 3 * 1.
  m: { campus: GA, cursus: ismin(2023), promo: 2023 },
  // The cohort: same promo AND formation (3), same formation (2), same campus (1).
  p3: { campus: SE, cursus: icm(2025), promo: 2025 },
  p2: { campus: SE, cursus: icm(2024), promo: 2024 },
  p1: { campus: SE, cursus: ismin(2025), promo: 2025 },
  // Elsewhere, linked to nobody: never a candidate.
  g: { campus: GA, cursus: ismin(2025), promo: 2025 },
  // Each would be tier 3, and each is excluded by one rule of decision 2.
  x: { campus: SE, cursus: icm(2025), promo: 2025 }, // already followed (accepted)
  pend: { campus: SE, cursus: icm(2025), promo: 2025 }, // a pending request
  blk1: { campus: SE, cursus: icm(2025), promo: 2025 }, // v blocked them
  blk2: { campus: SE, cursus: icm(2025), promo: 2025 }, // they blocked v
  dis: { campus: SE, cursus: icm(2025), promo: 2025 }, // v dismissed them
  rev: { campus: SE, cursus: icm(2025), promo: 2025 }, // a review account
  // A cursus that is not an array: tier 1 (the campus), and the statement does not fail.
  odd: { campus: SE, cursus: { formation: 'ICM' }, promo: null },
};

const E1 = '5e000000-0000-4000-8000-000000000001'; // 2 followers
const E2 = '5e000000-0000-4000-8000-000000000002'; // 5 followers
const E3 = '5e000000-0000-4000-8000-000000000003'; // v follows it
const E4 = '5e000000-0000-4000-8000-000000000004'; // archived
const E5 = '5e000000-0000-4000-8000-000000000005'; // v and m are members
const E6 = '5e000000-0000-4000-8000-000000000006'; // v dismissed it
const E7 = '5e000000-0000-4000-8000-000000000007'; // addresses Gardanne only

maybe('follow suggestions against PostgreSQL (engagement WP-5)', () => {
  const schema = `suggest_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let service: SuggestionsService;
  const previousCohort = process.env[REVIEW_COHORT_ENV];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const follow = (a: string, b: string, status: 'accepted' | 'pending' = 'accepted') =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), $1, $2, $3::varchar, CASE WHEN $3::varchar = 'accepted' THEN now() END)`,
      [a, b, status]
    );
  const followEntity = (who: string, id: string) =>
    q(
      `INSERT INTO association_follows (id, "followerUserId", "associationId")
       VALUES (gen_random_uuid(), $1, $2)`,
      [who, id]
    );

  beforeAll(async () => {
    process.env[REVIEW_COHORT_ENV] = 'rev';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        "logoUrl" varchar, type varchar NOT NULL DEFAULT 'association',
        "isBDE" boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE association_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "associationId" uuid NOT NULL);
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
    `);
    await q(migration('114_user_follow_status.sql'));
    for (const [id, u] of Object.entries(USERS)) {
      await q(`INSERT INTO users (id, campus, cursus, promo) VALUES ($1, $2, $3, $4)`, [
        id,
        u.campus,
        JSON.stringify(u.cursus),
        u.promo,
      ]);
    }
    // E1..E6 exist when 071 runs, which gives each the (ICM, saint-etienne) rule; E7 comes after
    // and addresses Gardanne only.
    for (const [id, n] of [E1, E2, E3, E4, E5, E6].map((id, i) => [id, i + 1] as const)) {
      await q(`INSERT INTO associations (id, name, slug, archived) VALUES ($1, $2, $3, $4)`, [
        id,
        `E${n}`,
        `e${n}`,
        id === E4,
      ]);
    }
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'E7', 'e7')`, [E7]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
      [E7, GA]
    );
    await q(migration('155_follow_suggestion_dismissals.sql'));
    // "Suggestions" is off until turned on (owner, 2026-11-10): every reader here turned it on but p2.
    await createNotificationPreferenceTable((sql) => q(sql));
    await turnSuggestionsOn(
      q,
      Object.keys(USERS).filter((id) => id !== 'p2')
    );

    for (const f of ['f1', 'f2', 'f3', 'f4', 'f5']) await follow('v', f);
    await follow('v', 'f6', 'pending');
    for (const f of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) await follow(f, 'c1');
    await follow('f1', 'c2', 'pending');
    // A follow of an account that no longer exists (its `users` row is gone): never suggested.
    await follow('f1', 'ghost');
    await q(`INSERT INTO user_blocks VALUES ('f5', 'v')`);
    await follow('v', 'x');
    await follow('v', 'pend', 'pending');
    await q(`INSERT INTO user_blocks VALUES ('v', 'blk1'), ('blk2', 'v')`);
    await q(
      `INSERT INTO follow_suggestion_dismissals ("userId", "targetKind", "targetId")
       VALUES ('v', 'user', 'dis'), ('v', 'association', $1)`,
      [E6]
    );
    await q(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'v'), ($1, 'm')`,
      [E5]
    );
    await followEntity('v', E3);
    for (const who of ['f1', 'f2']) await followEntity(who, E1);
    for (const who of ['f1', 'f2', 'f3', 'f4', 'g']) await followEntity(who, E2);
    for (const who of ['f1', 'f2', 'f3', 'f4', 'g', 'm']) await followEntity(who, E4);

    const db = {
      query: async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows,
    } as unknown as DataSource;
    service = new SuggestionsService(db);
  });

  afterAll(async () => {
    if (previousCohort === undefined) delete process.env[REVIEW_COHORT_ENV];
    else process.env[REVIEW_COHORT_ENV] = previousCohort;
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('serves nothing to a reader who did not turn Suggestions on, but still counts their follows', async () => {
    await follow('p2', 'p3');
    expect(await service.suggestionsFor('p2')).toEqual({
      people: [],
      entities: [],
      followingCount: 1,
    });
    await q(`DELETE FROM user_follows WHERE "followerUserId" = 'p2'`);
  });

  it('ranks by L10 and excludes everything decision 2 excludes', async () => {
    const { people } = await service.suggestionsFor('v');
    // c1 16 (4 mutual), m 3 (one shared association), p3 3 (tier 3; m < p3 by id), p2 2, then
    // the tier-1 campus: odd and p1 by id.
    expect(people.map((p) => p.userId)).toEqual(['c1', 'm', 'p3', 'p2', 'odd', 'p1']);
  });

  it('counts "N en commun" and draws faces from the same pool: accepted, no block, at most three', async () => {
    const { people } = await service.suggestionsFor('v');
    const c1 = people.find((p) => p.userId === 'c1')!;
    // f5 (a block with v) and f6 (only asked) follow c1 too, and are neither counted nor shown.
    expect(c1.mutual).toBe(4);
    expect(c1.faces).toEqual(['f1', 'f2', 'f3']);
    const p3 = people.find((p) => p.userId === 'p3')!;
    expect(p3).toEqual({ userId: 'p3', mutual: 0, faces: [] });
  });

  it('a block between the viewer and a face removes it from the faces and the count', async () => {
    await q(`INSERT INTO user_blocks VALUES ('v', 'f1')`);
    try {
      const c1 = (await service.suggestionsFor('v')).people.find((p) => p.userId === 'c1')!;
      expect(c1.mutual).toBe(3);
      expect(c1.faces).toEqual(['f2', 'f3', 'f4']);
    } finally {
      await q(`DELETE FROM user_blocks WHERE "blockerId" = 'v' AND "blockedId" = 'f1'`);
    }
  });

  it('counts what the viewer follows for the onboarding banner: accepted persons and entities (L12)', async () => {
    // f1..f5 and x accepted, f6 and pend only asked; E3 followed.
    expect((await service.suggestionsFor('v')).followingCount).toBe(7);
    expect((await service.suggestionsFor('p1')).followingCount).toBe(0);
  });

  it('a review account is suggested to nobody outside the cohort, and sees no member', async () => {
    expect((await service.suggestionsFor('v')).people.map((p) => p.userId)).not.toContain('rev');
    // rev shares v's campus, promo and formation: nothing of it crosses the boundary.
    expect((await service.suggestionsFor('rev')).people).toEqual([]);
  });

  it('suggests entities its audience rules reach, by follower count, none followed, archived, joined or dismissed', async () => {
    const { entities } = await service.suggestionsFor('v');
    expect(entities.map((e) => e.name)).toEqual(['E2', 'E1']);
    expect(entities[0]).toEqual({
      id: E2,
      name: 'E2',
      slug: 'e2',
      logoUrl: null,
      type: 'association',
    });
    // Gardanne's reader is reached by E7 alone.
    expect((await service.suggestionsFor('g')).entities.map((e) => e.name)).toEqual(['E7']);
  });

  it('"Suivez aussi..." drops the account just followed and keeps the page full (L15)', async () => {
    const { people } = await service.suggestionsFor('v', { peopleLimit: 3, exclude: 'c1' });
    expect(people.map((p) => p.userId)).toEqual(['m', 'p3', 'p2']);
  });

  it('a dismissal is permanent and idempotent; a bad one is a typed 400', async () => {
    await service.dismiss('v', 'user', 'p3');
    await service.dismiss('v', 'user', 'p3');
    await service.dismiss('v', 'association', E2.toUpperCase());
    const after = await service.suggestionsFor('v');
    expect(after.people.map((p) => p.userId)).not.toContain('p3');
    expect(after.entities.map((e) => e.name)).toEqual(['E1']);
    // A follow then an unfollow does not bring a dismissed account back.
    await follow('v', 'p3');
    await q(`DELETE FROM user_follows WHERE "followerUserId" = 'v' AND "followedUserId" = 'p3'`);
    expect((await service.suggestionsFor('v')).people.map((p) => p.userId)).not.toContain('p3');
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM follow_suggestion_dismissals WHERE "userId" = 'v'`
    );
    expect(rows[0].n).toBe(4);
    for (const [kind, id] of [
      ['person', 'p2'],
      ['association', 'not-a-uuid'],
      ['user', ''],
      ['user', 'v'],
      ['user', 'x'.repeat(256)],
    ]) {
      const err: unknown = await service.dismiss('v', kind, id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: SUGGESTION_DISMISS_INVALID,
      });
    }
  });

  it('the erasure deletes every dismissal naming the account, as reader or as target', async () => {
    await service.dismiss('m', 'user', 'v');
    await service.dismiss('p1', 'user', 'p2');
    const stmt = ERASURE_STATEMENTS.find((s) => s.label === 'follow_suggestion_dismissals')!;
    await q(stmt.sql, ['v']);
    const { rows } = await q(
      `SELECT "userId", "targetId" FROM follow_suggestion_dismissals ORDER BY 1`
    );
    expect(rows).toEqual([{ userId: 'p1', targetId: 'p2' }]);
  });

  it('migration 155 re-runs clean', async () => {
    await expect(q(migration('155_follow_suggestion_dismissals.sql'))).resolves.toBeDefined();
  });
});
