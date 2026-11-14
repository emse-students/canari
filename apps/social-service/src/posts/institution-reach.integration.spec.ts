/**
 * AN INSTITUTION'S REACH AGAINST A REAL POSTGRESQL (owner, 2026-11-10) - migrations 071, 072, 073,
 * 078, 121, 123, 127, 132, 133 and 162 applied, 162 on a `posts` table that does not have the columns.
 *
 * The rule: an institution chooses, at every post, the SPACES of its own audience the post targets
 * and the PUBLIC in them - everyone, the students (an account with a cursus), the staff (none). The
 * spaces narrow the institution's own door (its rules and a read grant), never a membership nor a
 * republisher's door (G4); the public narrows every door but the author's. ONE predicate,
 * `postVisibleToUserSql`, so every consumer is asked here through its own shipped code, each with
 * the reach the cases below write - and an edit is just a new row value, read at once.
 *
 * The cast, and the door each one has to I's post P when P carries no reach:
 *   si  - a student, ICM x Saint-Etienne                      - I's rules (whole Saint-Etienne)
 *   ss  - a student, ISMIN x Saint-Etienne                    - I's rules
 *   sg  - a student, ISMIN x Gardanne                         - carrier C's republication (G4)
 *   mb  - a member of I, no cursus                             - its membership
 *   off - the officer who wrote P, a member of I, no cursus   - authorship
 *   nr  - a named reader (grant: ICM x Saint-Etienne), staff   - the grant
 *   nf  - a named reader (grant: ISMIN x Saint-Etienne), staff - the grant
 *   sf  - staff, a member of carrier C                         - C's republication
 *   os  - staff of Saint-Etienne, no other door                - staff by campus ("Tous", "Personnel")
 *   og  - staff of Gardanne, no door at all                    - nothing (I does not reach Gardanne)
 *   ad  - a platform admin of Saint-Etienne, no cursus         - by id; staff by campus
 *
 * THE STAFF-BY-CAMPUS DOOR (owner, 2026-11-14): a "Tous" or "Personnel" post opens to every staff
 * account (a campus, no cursus) of a ticked space's campus - `os` and `ad` here - and to no staff of
 * another campus (`og`); a student gains nothing, and a post with no reach opens nothing new.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- institution-reach.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { PostsService } from './posts.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import { bellRowShownSql, type PostNotificationsService } from './post-notifications.service';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import type { PostMediaRetentionService } from './post-media-retention.service';
import type { ListPostsFeed, ListPostsParams } from './list-feed';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import {
  INSTITUTION_REACH_CODES,
  institutionReachOptions,
  resolveInstitutionReachWrite,
  type InstitutionReach,
} from '../spaces/institution-reach';
import {
  IN_FEED_AUDIENCE_SQL,
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  announceRecipientsSql,
  postReachesSpaceSql,
  postVisibleToViewerSql,
} from '../spaces/reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const USERS: Record<string, { campus: string | null; formation: string | null; admin?: boolean }> =
  {
    si: { campus: SE, formation: 'ICM' },
    ss: { campus: SE, formation: 'ISMIN' },
    sg: { campus: GA, formation: 'ISMIN' },
    mb: { campus: SE, formation: null },
    off: { campus: SE, formation: null },
    nr: { campus: null, formation: null },
    nf: { campus: null, formation: null },
    sf: { campus: GA, formation: null },
    os: { campus: SE, formation: null },
    og: { campus: GA, formation: null },
    ad: { campus: SE, formation: null, admin: true },
    // Only for the "never wider than the audience" case: a student of a space I does not reach.
    gi: { campus: GA, formation: 'ICM' },
  };
const READERS = ['si', 'ss', 'sg', 'mb', 'off', 'nr', 'nf', 'sf', 'os', 'og', 'ad'] as const;
type Reader = (typeof READERS)[number];

const I = '00000000-0000-4000-8000-0000000e0001'; // institution, the whole Saint-Etienne campus
const C = '00000000-0000-4000-8000-0000000e0002'; // association, all Gardanne: republishes P
const A = '00000000-0000-4000-8000-0000000e0003'; // an ordinary association, ICM x Saint-Etienne
const P = '00000000-0000-4000-8000-0000000001f1'; // I's post, republished by C
const Q = '00000000-0000-4000-8000-0000000001f2'; // I's post, carried by nobody

const ICM_SE = { formation: 'ICM', campus: SE };
const ISMIN_SE = { formation: 'ISMIN', campus: SE };
const ICM_GA = { formation: 'ICM', campus: GA };

/** The four reaches the cases write, and who reads P under each (the predicate's answer). */
const CASES: {
  name: string;
  reach: InstitutionReach | null;
  readers: Reader[];
}[] = [
  {
    name: 'no reach (a post written before it): the whole audience, everyone',
    reach: null,
    readers: ['si', 'ss', 'sg', 'mb', 'off', 'nr', 'nf', 'sf'],
  },
  {
    // ss loses its space and nf its grant cell; the member, the republisher's readers keep theirs;
    // Saint-Etienne's staff (os, ad) come in by campus, Gardanne's (og) do not (2026-11-14).
    name: 'ICM x Saint-Etienne, everyone',
    reach: { spaces: [ICM_SE], public: 'all' },
    readers: ['si', 'sg', 'mb', 'off', 'nr', 'sf', 'os', 'ad'],
  },
  {
    // Staff - named readers and the carrier's staff - lose it; I's own member keeps it (D21).
    name: 'ICM and ISMIN x Saint-Etienne, students',
    reach: { spaces: [ICM_SE, ISMIN_SE], public: 'students' },
    readers: ['si', 'ss', 'sg', 'mb', 'off'],
  },
  {
    // Students lose it, wherever they come from; staff keep the doors they had, and Saint-Etienne's
    // staff with no other door read it by campus (os, ad) - Gardanne's (og) do not (2026-11-14).
    name: 'ICM and ISMIN x Saint-Etienne, staff',
    reach: { spaces: [ICM_SE, ISMIN_SE], public: 'staff' },
    readers: ['mb', 'off', 'nr', 'nf', 'sf', 'os', 'ad'],
  },
];

maybe("an institution's reach against PostgreSQL (migration 162)", () => {
  const schema = `institution_reach_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let service: PostsService;
  let manager: EntityManager;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Writes a reach on a post as the shipped write stores it: two columns, nothing else. */
  const setReach = (id: string, reach: InstitutionReach | null) =>
    q(`UPDATE posts SET "reachPublic" = $2, "reachSpaces" = $3::jsonb WHERE id = $1`, [
      id,
      reach?.public ?? null,
      reach ? JSON.stringify(reach.spaces) : null,
    ]);

  /** The readers of `READERS` for whom `test` holds. */
  async function whoOf(test: (reader: Reader) => Promise<boolean>): Promise<Reader[]> {
    const out: Reader[] = [];
    for (const reader of READERS) if (await test(reader)) out.push(reader);
    return out;
  }

  const visible = async (reader: string, id = P) =>
    (
      await q(`SELECT ${postVisibleToViewerSql('posts', '$2')} AS v FROM posts WHERE id = $1`, [
        id,
        reader,
      ])
    )[0].v === true;

  /** THE SHIPPED FEED ARM (`listPostRows`, private: its decoration reads tables not built here). */
  async function feedHas(feed: ListPostsFeed, reader: Reader, postId: string): Promise<boolean> {
    const params: ListPostsParams = { feed, viewerUserId: reader, limit: 100, offset: 0 };
    const rows: { id: string }[] = await (
      service as unknown as { listPostRows(p: ListPostsParams): Promise<{ id: string }[]> }
    ).listPostRows(params);
    return rows.some((r) => r.id === postId);
  }

  /** The shipped statement `marker` matches inside a PostsService call, and its rows. */
  async function statementRows(
    marker: RegExp,
    call: (svc: PostsService) => Promise<unknown>
  ): Promise<{ id: string }[]> {
    const stop = new Error('stopped after the statement under test');
    let captured: { id: string }[] | null = null;
    const probe = new PostsService(
      {
        manager: {
          query: async (sql: string, params?: unknown[]) => {
            const rows = await q(sql, params ?? []);
            if (marker.test(sql)) {
              captured = rows;
              throw stop;
            }
            return rows;
          },
        },
      } as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      {} as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
    await call(probe).catch((e: unknown) => {
      if (e !== stop) throw e;
    });
    if (captured === null) throw new Error(`no statement matched ${marker}`);
    return captured;
  }

  const row = async (id: string): Promise<OpenablePost> =>
    (
      await q(
        `SELECT id, "authorId", "associationId", anonymous, "hiddenByModeration", "scheduledAt",
                kind, "expiresAt" FROM posts WHERE id = $1`,
        [id]
      )
    )[0];

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    manager = ds.manager;
    await q(`CREATE SCHEMA ${schema}`);
    // `posts` WITHOUT the reach columns: migration 162 adds them, as it will on every estate.
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "logoUrl" varchar, "logoMediaId" varchar, "isBDE" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(255));
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, "durationMs" int,
        markdown text, mentions text, links jsonb, "attachedFormId" uuid,
        "linkedCalendarEventId" uuid, images jsonb NOT NULL DEFAULT '[]',
        polls jsonb NOT NULL DEFAULT '[]', forms jsonb NOT NULL DEFAULT '[]',
        reactions jsonb NOT NULL DEFAULT '{}', comments jsonb NOT NULL DEFAULT '[]',
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY,
        presentation varchar(16) NOT NULL DEFAULT 'association');
    `);
    await createPostNotificationsTable(q);
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '121_member_reposts.sql',
      '148_profile_birthdays.sql',
      '123_member_repost_notices.sql',
      '127_post_space_pins.sql',
      '132_read_grant_readers.sql',
      '133_post_students_only.sql',
      '162_institution_post_reach.sql',
    ]) {
      await q(migration(file));
    }
    await q(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS "liveId" uuid NULL`);
    for (const [id, name, type, rule] of [
      [I, 'I', 'institution', [null, SE]],
      [C, 'C', 'association', [null, GA]],
      [A, 'A', 'association', ['ICM', SE]],
    ] as const) {
      await q(`INSERT INTO associations (id, name, slug, type) VALUES ($1, $2, $2, $3)`, [
        id,
        name,
        type,
      ]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [id, rule[0], rule[1]]
      );
    }
    for (const [id, u] of Object.entries(USERS)) {
      await q(
        `INSERT INTO users (id, admin, campus, cursus, "firstName", "lastName")
           VALUES ($1, $2, $3, $4, $1, 'X')`,
        [
          id,
          u.admin === true,
          u.campus,
          JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : []),
        ]
      );
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId") VALUES
         ($1, 'mb'), ($1, 'off'), ($2, 'sf')`,
      [I, C]
    );
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES
         ('nr', $1, 'ICM', 'admin'), ('nf', $1, 'ISMIN', 'admin')`,
      [SE]
    );
    for (const id of [P, Q]) {
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", markdown) VALUES ($1, 'off', $2, $3)`,
        [id, I, 'la rentrée de l école']
      );
    }
    await q(
      `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'officer')`,
      [P, C]
    );

    service = new PostsService(
      { manager } as unknown as Repository<Post>,
      {} as RedisService,
      {
        getFollowedAssociationIdsForUser: () => Promise.resolve([]),
        getFollowedUserIdsForUser: () => Promise.resolve([]),
      } as unknown as FollowsService,
      {} as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
  });

  afterEach(async () => {
    await setReach(P, null);
    await setReach(Q, null);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('migration 162: every post starts with no reach, the CHECKs hold, a re-run is safe', async () => {
    const rows = await q(`SELECT count(*)::int AS n FROM posts WHERE "reachPublic" IS NOT NULL`);
    expect(rows[0].n).toBe(0);
    // A personal post never carries a reach.
    await expect(
      q(`INSERT INTO posts (id, "authorId", "reachPublic", "reachSpaces")
           VALUES (gen_random_uuid(), 'si', 'all', '[{"formation":"ICM","campus":"saint-etienne"}]')`)
    ).rejects.toThrow(/CHK_posts_reach_together/);
    // The two columns go together.
    await expect(q(`UPDATE posts SET "reachPublic" = 'all' WHERE id = $1`, [Q])).rejects.toThrow(
      /CHK_posts_reach_together/
    );
    // An unknown public, an empty list, a value that is not a list.
    await expect(
      q(`UPDATE posts SET "reachPublic" = 'alumni', "reachSpaces" = '[{}]' WHERE id = $1`, [Q])
    ).rejects.toThrow(/CHK_posts_reach_public/);
    for (const spaces of ['[]', '{"formation":"ICM"}']) {
      await expect(
        q(`UPDATE posts SET "reachPublic" = 'all', "reachSpaces" = $2::jsonb WHERE id = $1`, [
          Q,
          spaces,
        ])
      ).rejects.toThrow(/CHK_posts_reach_spaces_shape/);
    }
    await q(migration('162_institution_post_reach.sql'));
  });

  it.each(CASES)('THE PREDICATE - $name', async ({ reach, readers }) => {
    await setReach(P, reach);
    expect(await whoOf((r) => visible(r))).toEqual(readers);
  });

  it.each(CASES)(
    'the associations and all feeds (`listPostRows`) - $name',
    async ({ reach, readers }) => {
      await setReach(P, reach);
      for (const feed of ['associations', 'all'] as const) {
        expect(await whoOf((r) => feedHas(feed, r, P))).toEqual(readers);
      }
    }
  );

  it.each(CASES)('the search (`searchPosts`) - $name', async ({ reach, readers }) => {
    await setReach(P, reach);
    const found = async (reader: Reader) =>
      (
        await statementRows(/ILIKE \$3/, (svc) =>
          svc.searchPosts('rentrée', 20, 0, { viewerUserId: reader })
        )
      ).some((r) => r.id === P);
    expect(await whoOf(found)).toEqual(readers);
  });

  it.each(CASES)(
    'the post by id, read and comment (`readPostOpenVerdict`) - $name',
    async ({ reach, readers }) => {
      await setReach(P, reach);
      for (const intent of ['READ_OR_REACT', 'COMMENT'] as const) {
        const opens = async (reader: Reader) =>
          (await readPostOpenVerdict(manager, await row(P), { viewerId: reader }, intent))
            .refusal === null;
        // By id the platform admin opens any post - except one for students only, as the switch.
        // A named reader's comments stay withheld (#2998): their grant opens the read only.
        const expected = READERS.filter(
          (r) =>
            (readers.includes(r) && (intent === 'READ_OR_REACT' || (r !== 'nr' && r !== 'nf'))) ||
            (r === 'ad' && reach?.public !== 'students')
        );
        expect(await whoOf(opens)).toEqual(expected);
      }
    }
  );

  it.each(CASES)(
    'the bell (`bellRowShownSql`) and the announcement - $name',
    async ({ reach, readers }) => {
      await setReach(P, reach);
      const shown = async (reader: Reader) =>
        (
          await q(
            `SELECT ${bellRowShownSql('n')} AS shown FROM (VALUES ('association_post'::varchar,
             $1::varchar, $2::varchar, 'off'::varchar, NULL::varchar))
             AS n(type, "postId", "recipientId", "actorId", "commentId")`,
            [P, reader]
          )
        )[0].shown === true;
      expect(await whoOf(shown)).toEqual(readers);
      // A grant never notifies (WP7), and the author is never told of their own post. `gi`, outside
      // the cast, is C's student in Gardanne: told whenever a student may read P (G4).
      const all = ((await q(announceRecipientsSql(false), [P])) as { id: string }[]).map(
        (r) => r.id
      );
      expect(all.includes('gi')).toBe(reach?.public !== 'staff');
      const announced = all.filter((id) => id !== 'gi').sort();
      expect(announced).toEqual(
        readers.filter((r) => r !== 'off' && r !== 'nr' && r !== 'nf').sort()
      );
    }
  );

  it("a republication still reaches its carrier's own readers, minus those the public refuses", async () => {
    // Carrier A (ICM x Saint-Etienne) reaches si. P ticks ISMIN only, so si does not read it now.
    await setReach(P, { spaces: [ISMIN_SE], public: 'staff' });
    const newly = async () =>
      ((await q(NEWLY_REACHED_BY_REPUBLICATION_SQL, [P, A])) as { id: string }[])
        .map((r) => r.id)
        .sort();
    // A's readers are si (a student, refused by 'staff') and nobody else: none newly reached.
    expect(await newly()).toEqual([]);
    await setReach(P, { spaces: [ISMIN_SE], public: 'students' });
    // si does not read P (ICM not ticked) and A would carry it to them: newly reached.
    expect(await newly()).toEqual(['si']);
  });

  it('a space: the pins and trends read the ticked spaces only (`postReachesSpaceSql`)', async () => {
    const reaches = async () =>
      (
        (await q(
          `SELECT s.formation FROM spaces s JOIN posts p ON p.id = $1
            WHERE s.campus = $2 AND ${postReachesSpaceSql('p', 's')}
            ORDER BY s.formation`,
          [Q, SE]
        )) as { formation: string }[]
      ).map((r) => r.formation);
    expect(await reaches()).toEqual(['Autre', 'FSSS', 'ICM', 'ISMIN', 'PDIS']);
    await setReach(Q, { spaces: [ICM_SE, ISMIN_SE], public: 'all' });
    expect(await reaches()).toEqual(['ICM', 'ISMIN']);
    await setReach(Q, { spaces: [ICM_SE, ISMIN_SE], public: 'students' });
    expect(await reaches()).toEqual(['ICM', 'ISMIN']);
    // A space's readers are students: a staff-only post reaches no space, so takes no pin slot.
    await setReach(Q, { spaces: [ICM_SE, ISMIN_SE], public: 'staff' });
    expect(await reaches()).toEqual([]);
  });

  it('NEVER WIDER THAN THE AUDIENCE: a ticked space the institution does not reach opens nothing', async () => {
    // Written past the write (which refuses it, below): the read ANDs it with I's rules anyway.
    await setReach(Q, { spaces: [ICM_GA], public: 'all' });
    expect(await visible('gi', Q)).toBe(false);
    expect(await visible('si', Q)).toBe(false);
    // The member and the author keep their doors.
    expect(await visible('mb', Q)).toBe(true);
    expect(await visible('off', Q)).toBe(true);
  });

  it('an edit narrows then widens, read at once - nothing stored anywhere else', async () => {
    await setReach(P, { spaces: [ICM_SE], public: 'students' });
    expect(await feedHas('associations', 'ss', P)).toBe(false);
    expect(await feedHas('associations', 'nr', P)).toBe(false);
    await setReach(P, { spaces: [ICM_SE, ISMIN_SE], public: 'all' });
    expect(await feedHas('associations', 'ss', P)).toBe(true);
    expect(await feedHas('associations', 'nr', P)).toBe(true);
  });

  describe('THE STAFF-BY-CAMPUS DOOR (owner, 2026-11-14)', () => {
    it("a staff account of a ticked space's campus reads a Personnel and a Tous post, through every path", async () => {
      for (const pub of ['staff', 'all'] as const) {
        await setReach(Q, { spaces: [ISMIN_SE], public: pub });
        // Q is carried by nobody: os has no membership, no grant, no follow - only its campus.
        expect(await visible('os', Q)).toBe(true);
        expect(await feedHas('associations', 'os', Q)).toBe(true);
        expect(await feedHas('all', 'os', Q)).toBe(true);
        expect(
          (await readPostOpenVerdict(manager, await row(Q), { viewerId: 'os' }, 'COMMENT')).refusal
        ).toBeNull();
        const announced = ((await q(announceRecipientsSql(false), [Q])) as { id: string }[]).map(
          (r) => r.id
        );
        expect(announced).toContain('os');
        // Gardanne's staff is on a campus Q does not tick: nothing, by any path.
        expect(await visible('og', Q)).toBe(false);
        expect(announced).not.toContain('og');
      }
    });

    it('a student is not affected: their door is still their own space', async () => {
      await setReach(Q, { spaces: [ISMIN_SE], public: 'staff' });
      expect(await visible('ss', Q)).toBe(false);
      expect(await visible('si', Q)).toBe(false);
      await setReach(Q, { spaces: [ISMIN_SE], public: 'all' });
      expect(await visible('ss', Q)).toBe(true);
      // si's space (ICM) is not ticked: the campus they share with the ticked space opens nothing.
      expect(await visible('si', Q)).toBe(false);
    });

    it('closed by "Étudiants", by no reach, and by a ticked space the audience does not reach', async () => {
      await setReach(Q, { spaces: [ISMIN_SE], public: 'students' });
      expect(await visible('os', Q)).toBe(false);
      // A post written before the reach: its readers are what they were.
      await setReach(Q, null);
      expect(await visible('os', Q)).toBe(false);
      // Never wider than the audience: I does not reach Gardanne, so its staff gain nothing.
      await setReach(Q, { spaces: [ICM_GA], public: 'staff' });
      expect(await visible('og', Q)).toBe(false);
      expect(await visible('os', Q)).toBe(false);
    });

    it("the feed gate admits staff of a campus an institution reaches, not another campus's", async () => {
      const inAudience = async (id: string) =>
        ((await q(IN_FEED_AUDIENCE_SQL, [id])) as { inAudience: boolean }[])[0].inAudience;
      expect(await inAudience('os')).toBe(true);
      expect(await inAudience('og')).toBe(false);
    });
  });

  describe('the write (`resolveInstitutionReachWrite`) against the real audience', () => {
    const write = (
      associationId: string,
      type: string | null,
      raw: unknown,
      mode: 'create' | 'edit' = 'create'
    ) => resolveInstitutionReachWrite(manager, { mode, associationId, associationType: type, raw });
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        if (e instanceof BadRequestException) {
          return (e.getResponse() as { code?: string }).code;
        }
        throw e;
      }
      return null;
    };

    it("offers every space of the institution's audience, campus then formation", async () => {
      expect(await institutionReachOptions(manager, I)).toEqual(
        ['Autre', 'FSSS', 'ICM', 'ISMIN', 'PDIS'].map((formation) => ({ formation, campus: SE }))
      );
    });

    it('stores a reach inside the audience, sorted and folded', async () => {
      expect(
        await write(I, 'institution', {
          spaces: [ISMIN_SE, ICM_SE, ISMIN_SE],
          public: 'staff',
        })
      ).toEqual({ reachPublic: 'staff', reachSpaces: [ICM_SE, ISMIN_SE] });
    });

    it('refuses, typed: missing, outside the audience, malformed, on another kind of entity', async () => {
      expect(await codeOf(write(I, 'institution', undefined))).toBe(
        INSTITUTION_REACH_CODES.required
      );
      expect(await codeOf(write(I, 'institution', { spaces: [ICM_GA], public: 'all' }))).toBe(
        INSTITUTION_REACH_CODES.outsideAudience
      );
      expect(await codeOf(write(I, 'institution', { spaces: [], public: 'all' }))).toBe(
        INSTITUTION_REACH_CODES.invalid
      );
      expect(await codeOf(write(I, 'institution', { spaces: [ICM_SE], public: 'alumni' }))).toBe(
        INSTITUTION_REACH_CODES.invalid
      );
      expect(await codeOf(write(A, 'association', { spaces: [ICM_SE], public: 'all' }))).toBe(
        INSTITUTION_REACH_CODES.notOffered
      );
      // An association's post without one, and an edit that names none: nothing to decide.
      expect(await write(A, 'association', undefined)).toBeUndefined();
      expect(await write(I, 'institution', undefined, 'edit')).toBeUndefined();
    });
  });
});
