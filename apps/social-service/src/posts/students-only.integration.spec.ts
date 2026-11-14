/**
 * THE "ENTRE ÉTUDIANTS" SWITCH AGAINST A REAL POSTGRESQL (owner, 2026-11-04) - migrations 071, 072,
 * 073, 078, 121, 123, 127, 132 and 133 applied, 133 on a `posts` table that does not have the column.
 *
 * The rule: a post marked `studentsOnly` is read by students (an account with a cursus, so a space)
 * and by the members of the association that published it, WHATEVER THE PATH; staff without a cursus
 * and named readers see nothing of it. ONE conjunct of `postVisibleToUserSql`
 * (`studentsOnlyAdmitsUserSql`), so every consumer is asked here through its own shipped code, each
 * with the switch OFF (the reader is reached, so the test is not vacuous) and then ON:
 *
 *   the feed's four arms and the CanaReels viewer (`listPostRows`), the search (`searchPosts`'s
 *   statement), the post by id with every intent (`readPostOpenVerdict`: read, react, comment, vote),
 *   the comments withheld from a named reader (#2998), the reactions' answer (`serveReactionsTo`),
 *   the bell (`bellRowShownSql`), the announcement (`announceRecipientsSql`), a mention
 *   (`mentionRecipientsOf`), the republication's and the member repost's newly-reached readers, a pin,
 *   and the agenda's link back to the post (`findPostLinkedToCalendarEvent`'s statement).
 *
 * The cast, and how each one reaches A1's post P when the switch is OFF:
 *   st  - a student of A1's space (ICM, Saint-Etienne)          - its space
 *   rp  - a student of A1's space, who REPOSTED P and R         - its space
 *   sg  - a student of Gardanne                                  - carrier C's republication
 *   mb  - a member of A1, no cursus                              - its membership
 *   off - the officer who wrote P, a member of A1, no cursus     - authorship
 *   sf  - staff, no cursus, a member of carrier C               - C's republication
 *   nr  - a named reader (grant: ICM x Saint-Etienne), no cursus - the grant
 *   fo  - staff, no cursus, an accepted follower of rp          - rp's member repost
 *   ad  - a platform admin, no cursus                           - by id only (moderation)
 *   os  - staff, no cursus, no door at all                      - nothing
 *
 * Outside the cast, for the lead's decisions of the review (2026-11-04): `gs`, a STUDENT of another
 * space (ISMIN x Saint-Etienne) who also holds a read grant on A1's cell - a grant never opens such a
 * post, even to a student; the platform admin opens it only to moderate (`allowHidden`); and a
 * repost PROPOSAL (`RepublicationsService.announce`, `describe`) keeps the proposal but withholds the
 * text from an acceptor the gate refuses.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- students-only.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { PostsService } from './posts.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import { bellRowShownSql, PostNotificationsService } from './post-notifications.service';
import { PostNotification } from './entities/post-notification.entity';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import type { PostMediaRetentionService } from './post-media-retention.service';
import type { ListPostsFeed, ListPostsParams } from './list-feed';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import { commentsWithheldPostIds } from './comments-withheld';
import { RepublicationsService } from './republications.service';
import {
  NEWLY_REACHED_BY_MEMBER_REPOST_SQL,
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  announceRecipientsSql,
  postVisibleToViewerSql,
  type PostAccessIntent,
} from '../spaces/reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
/** Every reader, by a readable id: a failure names a role. */
const USERS: Record<string, { campus: string | null; formation: string | null; admin?: boolean }> =
  {
    st: { campus: SE, formation: 'ICM' },
    rp: { campus: SE, formation: 'ICM' },
    sg: { campus: GA, formation: 'ISMIN' },
    mb: { campus: SE, formation: null },
    off: { campus: SE, formation: null },
    sf: { campus: SE, formation: null },
    nr: { campus: null, formation: null },
    fo: { campus: GA, formation: null },
    ad: { campus: SE, formation: null, admin: true },
    os: { campus: SE, formation: null },
    // Only for the newly-reached rules: staff in carrier C2, staff following st.
    s2: { campus: GA, formation: null },
    f2: { campus: GA, formation: null },
    // A student of ANOTHER space, with a read grant on A1's cell (ICM x Saint-Etienne).
    gs: { campus: SE, formation: 'ISMIN' },
  };
const READERS = ['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo', 'ad', 'os'] as const;
type Reader = (typeof READERS)[number];
/** Who still reads P with the switch ON: the students and A1's members (the officer is one). */
const ADMITTED: readonly Reader[] = ['st', 'rp', 'sg', 'mb', 'off'];

const A1 = '00000000-0000-4000-8000-0000000d0001'; // association, ICM x Saint-Etienne: publishes
const C = '00000000-0000-4000-8000-0000000d0002'; // association, all Gardanne: republishes P and R
const C2 = '00000000-0000-4000-8000-0000000d0003'; // association, ISMIN x Gardanne: never republishes
const EVENT = '00000000-0000-4000-8000-0000000d00e1';
const P = '00000000-0000-4000-8000-0000000000f1'; // A1's post
const R = '00000000-0000-4000-8000-0000000000f2'; // A1's reel

maybe('"Entre étudiants" against PostgreSQL (migration 133)', () => {
  const schema = `students_only_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let service: PostsService;
  let manager: EntityManager;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Sets the switch of both posts, as the shipped write stores it (one column, nothing else). */
  const setSwitch = (on: boolean) =>
    q(`UPDATE posts SET "studentsOnly" = $1 WHERE id = ANY($2::uuid[])`, [on, [P, R]]);

  /** Runs `body` with the switch OFF then ON, and hands back both answers. */
  async function bothWays<T>(body: () => Promise<T>): Promise<{ off: T; on: T }> {
    await setSwitch(false);
    const off = await body();
    await setSwitch(true);
    const on = await body();
    await setSwitch(false);
    return { off, on };
  }

  /** The readers of `READERS` for whom `test` holds. */
  async function whoOf(test: (reader: Reader) => Promise<boolean>): Promise<Reader[]> {
    const out: Reader[] = [];
    for (const reader of READERS) if (await test(reader)) out.push(reader);
    return out;
  }

  /** THE SHIPPED FEED ARM (`listPostRows`, private: its decoration reads tables not built here). */
  async function feedHas(feed: ListPostsFeed, reader: Reader, postId: string): Promise<boolean> {
    const params: ListPostsParams = {
      feed,
      viewerUserId: reader,
      limit: 100,
      offset: 0,
      ...(feed === 'reels' ? { kind: 'reel' as const } : {}),
    };
    const rows: { id: string }[] = await (
      service as unknown as { listPostRows(p: ListPostsParams): Promise<{ id: string }[]> }
    ).listPostRows(params);
    return rows.some((r) => r.id === postId);
  }

  /**
   * Runs a PostsService method whose statement under test is the one `marker` matches, against the
   * database, and stops right after it: what follows (decoration) reads services this spec does not
   * build. Returns that statement's rows - the shipped SQL, never a copy of it.
   */
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
      // The bell is read through its entity (`getNotifications`), so that one is mapped.
      entities: [PostNotification],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    manager = ds.manager;
    await q(`CREATE SCHEMA ${schema}`);
    // `posts` WITHOUT "studentsOnly": migration 133 adds it, as it will on every estate.
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
      -- The columns the agenda's link back reads: it joins the event, presented by its association.
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY,
        presentation varchar(16) NOT NULL DEFAULT 'association');
    `);
    // The bell's table as the estates hold it - its columns' types from the migrations (#3019's 500).
    await createPostNotificationsTable(q);
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '121_member_reposts.sql',
      // The bell re-reads a birthday notice against its date (`birthdayRowShownSql`).
      '148_profile_birthdays.sql',
      '123_member_repost_notices.sql',
      '127_post_space_pins.sql',
      '132_read_grant_readers.sql',
      '133_post_students_only.sql',
      '162_institution_post_reach.sql',
    ]) {
      await q(migration(file));
    }
    // The feed's select reads `posts."liveId"` (migration 156, live replays); that migration needs
    // the whole `lives` table, so only the column the select reads is added here.
    await q(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS "liveId" uuid NULL`);
    for (const [id, name, rule] of [
      [A1, 'A1', ['ICM', SE]],
      [C, 'C', [null, GA]],
      [C2, 'C2', ['ISMIN', GA]],
    ] as const) {
      await q(`INSERT INTO associations (id, name, slug) VALUES ($1, $2, $2)`, [id, name]);
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
         ($1, 'mb'), ($1, 'off'), ($2, 'sf'), ($3, 's2')`,
      [A1, C, C2]
    );
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES
         ('nr', $1, 'ICM', 'admin'), ('gs', $1, 'ICM', 'admin')`,
      [SE]
    );
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES
         ('fo', 'rp', 'accepted'), ('f2', 'st', 'accepted')`
    );
    await q(
      `INSERT INTO association_calendar_events (id, presentation) VALUES ($1, 'association')`,
      [EVENT]
    );
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", markdown, "linkedCalendarEventId")
         VALUES ($1, 'off', $2, 'la soirée des promos', $3)`,
      [P, A1, EVENT]
    );
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", markdown, kind, "expiresAt", images, "durationMs")
         VALUES ($1, 'off', $2, 'le reel des promos', 'reel', now() + interval '20 days',
                 '[{"type": "video", "mediaId": "v"}]', 1000)`,
      [R, A1]
    );
    for (const id of [P, R]) {
      await q(
        `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'officer')`,
        [id, C]
      );
      await q(`INSERT INTO member_reposts ("postId", "reposterId") VALUES ($1, 'rp')`, [id]);
    }
    // P is pinned in A1's space, which nr's grant cell holds: a pin shows to the cell's reader.
    await q(
      `INSERT INTO post_space_pins (post_id, space_id, pinned_by)
         SELECT $1, s.id, 'admin' FROM spaces s WHERE s.formation = 'ICM' AND s.campus = $2`,
      [P, SE]
    );

    const follows = {
      getFollowedAssociationIdsForUser: () => Promise.resolve([A1]),
      getFollowedUserIdsForUser: async (viewer: string) =>
        (
          (await q(
            `SELECT "followedUserId" FROM user_follows WHERE "followerUserId" = $1 AND status = 'accepted'`,
            [viewer]
          )) as { followedUserId: string }[]
        ).map((r) => r.followedUserId),
    } as unknown as FollowsService;
    service = new PostsService(
      { manager } as unknown as Repository<Post>,
      {} as RedisService,
      follows,
      {} as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('migration 133: every post starts open, a personal post refuses the switch, a re-run is safe', async () => {
    const rows = await q(`SELECT count(*)::int AS n FROM posts WHERE "studentsOnly"`);
    expect(rows[0].n).toBe(0);
    await expect(
      q(`INSERT INTO posts (id, "authorId", "studentsOnly") VALUES (gen_random_uuid(), 'st', true)`)
    ).rejects.toThrow(/CHK_posts_students_only_entity/);
    await q(migration('133_post_students_only.sql'));
  });

  it('THE PREDICATE: students and A1 members keep the post, every other door closes', async () => {
    const visible = (reader: Reader) => async () =>
      (
        await q(`SELECT ${postVisibleToViewerSql('posts', '$2')} AS v FROM posts WHERE id = $1`, [
          P,
          reader,
        ])
      )[0].v === true;
    const { off, on } = await bothWays(() => whoOf((r) => visible(r)()));
    // OFF: every door the cast was given opens (the admin and the outsider have none when browsing).
    expect(off).toEqual(['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']);
    expect(on).toEqual([...ADMITTED]);
  });

  it.each([
    // [feed, post, readers reached with the switch OFF]
    ['associations', P, ['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr']],
    ['all', P, ['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr']],
    ['followed', P, ['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']],
    ['reels', R, ['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']],
  ] as const)(
    'the %s feed: ON keeps exactly the students and the members',
    async (feed, id, reached) => {
      const { off, on } = await bothWays(() => whoOf((r) => feedHas(feed, r, id)));
      expect(off).toEqual([...reached]);
      expect(on).toEqual(reached.filter((r) => ADMITTED.includes(r)));
    }
  );

  it('the search (the shipped statement of `searchPosts`)', async () => {
    const found = (reader: Reader) => async () =>
      (
        await statementRows(/ILIKE \$3/, (svc) =>
          svc.searchPosts('soirée', 20, 0, { viewerUserId: reader })
        )
      ).some((r) => r.id === P);
    const { off, on } = await bothWays(() => whoOf((r) => found(r)()));
    expect(off).toEqual(['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']);
    expect(on).toEqual([...ADMITTED]);
  });

  it("the agenda's link back to the post (`findPostLinkedToCalendarEvent`); the event is not touched", async () => {
    const linked = (reader: Reader) => async () =>
      (
        await statementRows(/"linkedCalendarEventId" = \$1/, (svc) =>
          svc.findPostLinkedToCalendarEvent(EVENT, reader, false)
        )
      ).some((r) => r.id === P);
    const { off, on } = await bothWays(() => whoOf((r) => linked(r)()));
    expect(off).toEqual(['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']);
    expect(on).toEqual([...ADMITTED]);
  });

  it("the agenda's link back never serves a post scheduled for later, whoever reads", async () => {
    // Audience audit, 2026-11-14: the statement had no schedule term, so every reader of the
    // association read an unpublished post through the event's card.
    const linked = (reader: Reader) => async () =>
      (
        await statementRows(/"linkedCalendarEventId" = \$1/, (svc) =>
          svc.findPostLinkedToCalendarEvent(EVENT, reader, false)
        )
      ).some((r) => r.id === P);
    await q(`UPDATE posts SET "scheduledAt" = NOW() + interval '1 day' WHERE id = $1`, [P]);
    try {
      expect(await whoOf((r) => linked(r)())).toEqual([]);
    } finally {
      await q(`UPDATE posts SET "scheduledAt" = NULL WHERE id = $1`, [P]);
    }
    expect((await whoOf((r) => linked(r)())).length).toBeGreaterThan(0);
  });

  it.each(['READ_OR_REACT', 'COMMENT', 'VOTE'] as const)(
    'the post by id, intent %s (`readPostOpenVerdict`): ON, the admin browsing is refused too',
    async (intent: PostAccessIntent) => {
      const opens = (reader: Reader) => async () =>
        (await readPostOpenVerdict(manager, await row(P), { viewerId: reader }, intent)).refusal ===
        null;
      const { off, on } = await bothWays(() => whoOf((r) => opens(r)()));
      // The named reader: a grant opens a read and a reaction, never a vote, and since #2998 not
      // the comments either (their switch "voit les commentaires" is off).
      const nrOff = intent === 'READ_OR_REACT' ? ['nr'] : [];
      expect(off).toEqual(['st', 'rp', 'sg', 'mb', 'off', 'sf', ...nrOff, 'fo', 'ad']);
      expect(on).toEqual([...ADMITTED]);
    }
  );

  it.each(['READ_OR_REACT', 'COMMENT'] as const)(
    'the platform admin opens it ON only to MODERATE (`allowHidden`), intent %s (lead, 2026-11-04)',
    async (intent: PostAccessIntent) => {
      const { off, on } = await bothWays(async () => ({
        moderating:
          (
            await readPostOpenVerdict(
              manager,
              await row(P),
              { viewerId: 'ad', allowHidden: true },
              intent
            )
          ).refusal === null,
        acting:
          (await readPostOpenVerdict(manager, await row(P), { viewerId: 'ad' }, intent)).refusal ===
          null,
      }));
      expect(off).toEqual({ moderating: true, acting: true });
      // React, comment and vote routes never pass `allowHidden`: the admin is asked the gate there.
      expect(on).toEqual({ moderating: true, acting: false });
    }
  );

  it('a read grant never opens it, even to a student of another space (lead, 2026-11-04)', async () => {
    const reads = async () => ({
      byId:
        (await readPostOpenVerdict(manager, await row(P), { viewerId: 'gs' }, 'READ_OR_REACT'))
          .refusal === null,
      feed: await feedHas('associations', 'gs' as Reader, P),
      // A1's own student keeps it: the guard closes the grant door, nothing else.
      student: await feedHas('associations', 'st', P),
    });
    const { off, on } = await bothWays(reads);
    expect(off).toEqual({ byId: true, feed: true, student: true });
    expect(on).toEqual({ byId: false, feed: false, student: true });
  });

  it('a repost proposal keeps going to every acceptor, its text only to those the gate admits', async () => {
    const sent: { recipientIds: string[]; text: string }[] = [];
    const republications = new RepublicationsService(
      { manager } as never,
      {} as never,
      {
        createNotifications: (n: { recipientIds: string[]; text: string }) => {
          sent.push({ recipientIds: [...n.recipientIds].sort(), text: n.text });
          return Promise.resolve(n.recipientIds.length);
        },
      } as never,
      {} as never,
      {} as never
    );
    const proposal = {
      id: '00000000-0000-4000-8000-0000000000aa',
      kind: 'repost',
      subjectId: P,
      fromAssociationId: A1,
      toAssociationId: C2,
      proposedBy: 'off',
    };
    const { off, on } = await bothWays(async () => {
      sent.length = 0;
      // C2's acceptors: s2, its staff officer, and a student of it, sg.
      await republications.announce(proposal as never, ['s2', 'sg']);
      const queue = async (viewer: string) =>
        (await republications.describe([P], viewer)).get(P)?.preview;
      return { sent: [...sent], staffQueue: await queue('s2'), studentQueue: await queue('sg') };
    });
    expect(off).toEqual({
      sent: [{ recipientIds: ['s2', 'sg'], text: 'la soirée des promos' }],
      staffQueue: 'la soirée des promos',
      studentQueue: 'la soirée des promos',
    });
    expect(on).toEqual({
      sent: [
        { recipientIds: ['sg'], text: 'la soirée des promos' },
        { recipientIds: ['s2'], text: '' },
      ],
      staffQueue: '',
      studentQueue: 'la soirée des promos',
    });
  });

  it('composes with #2998: OFF, the named reader reads without the comments; ON, reads nothing', async () => {
    const { off, on } = await bothWays(async () => ({
      withheld: (await commentsWithheldPostIds(manager, [P], 'nr')).has(P),
      read:
        (await readPostOpenVerdict(manager, await row(P), { viewerId: 'nr' }, 'READ_OR_REACT'))
          .refusal === null,
    }));
    expect(off).toEqual({ withheld: true, read: true });
    // Nothing to withhold from a reader who no longer reads the post at all.
    expect(on).toEqual({ withheld: false, read: false });
  });

  it("a reaction's answer lists nobody to a reader the switch withdrew (`serveReactionsTo`)", async () => {
    const stored = { ok: true, reactions: { st: 'like', sf: 'love' } };
    const { off, on } = await bothWays(() => service.serveReactionsTo(P, 'sf', stored));
    expect(off).toBe(stored);
    expect(on).toEqual({ ok: true, reactions: { sf: 'love' } });
  });

  it('the bell: an association_post row shows to a withdrawn reader again once the switch is off', async () => {
    const shown = (reader: Reader) => async () =>
      (
        await q(
          `SELECT ${bellRowShownSql('n')} AS shown FROM (VALUES ('association_post'::varchar,
             $1::varchar, $2::varchar, 'off'::varchar, NULL::varchar))
             AS n(type, "postId", "recipientId", "actorId", "commentId")`,
          [P, reader]
        )
      )[0].shown === true;
    const { off, on } = await bothWays(() => whoOf((r) => shown(r)()));
    expect(off).toEqual(['st', 'rp', 'sg', 'mb', 'off', 'sf', 'nr', 'fo']);
    expect(on).toEqual([...ADMITTED]);
  });

  it('the announcement and a mention reach the students and the members only', async () => {
    const notifications = new PostNotificationsService(
      {} as never,
      { manager } as never,
      {} as never,
      {} as never
    );
    const { off, on } = await bothWays(async () => ({
      announced: ((await q(announceRecipientsSql(false), [P])) as { id: string }[])
        .map((r) => r.id)
        .sort(),
      mentioned: await notifications.mentionRecipientsOf(
        await row(P),
        'off',
        ['st', 'sf', 'nr', 'fo'],
        'READ_OR_REACT'
      ),
    }));
    // A grant never notifies (WP7), so nr is not announced even OFF; a mention follows the read.
    expect(off).toEqual({
      announced: ['fo', 'mb', 'rp', 'sf', 'sg', 'st'],
      mentioned: ['st', 'sf', 'nr', 'fo'],
    });
    expect(on).toEqual({ announced: ['mb', 'rp', 'sg', 'st'], mentioned: ['st'] });
  });

  it('a republication and a member repost stay allowed, and never reach a reader the switch refuses', async () => {
    const { off, on } = await bothWays(async () => ({
      // C2 would newly reach its staff member s2 (and nobody else: Gardanne's ISMIN already reads P).
      republication: ((await q(NEWLY_REACHED_BY_REPUBLICATION_SQL, [P, C2])) as { id: string }[])
        .map((r) => r.id)
        .sort(),
      // A repost by st would newly reach st's follower f2, staff of Gardanne.
      repost: ((await q(NEWLY_REACHED_BY_MEMBER_REPOST_SQL, [P, 'st'])) as { id: string }[]).map(
        (r) => r.id
      ),
    }));
    expect(off).toEqual({ republication: ['s2'], repost: ['f2'] });
    expect(on).toEqual({ republication: [], repost: [] });
  });

  it('a change of the switch is read at once: no stored audience to bring up to date', async () => {
    await setSwitch(true);
    expect(await feedHas('associations', 'nr', P)).toBe(false);
    await setSwitch(false);
    expect(await feedHas('associations', 'nr', P)).toBe(true);
  });

  it("a repost proposal's bell row written while the switch was OFF loses its text at the read once it is ON", async () => {
    // The proposal, and its bell rows as `announce` wrote them with the switch OFF: text for both.
    await q(
      `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "proposedBy")
         VALUES ('repost', $1, $2, $3, 'off')`,
      [P, A1, C2]
    );
    for (const recipient of ['s2', 'sg']) {
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName",
           "associationId", text) VALUES ($1, 'repost_proposed', $2, 'off', 'A1', $3, 'la soirée des promos')`,
        [recipient, C2, A1]
      );
    }
    const bell = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager } as never,
      {} as never,
      {} as never
    );
    const textOf = async (reader: string) =>
      (await bell.getNotifications(reader)).find((n) => n.type === 'repost_proposed')?.text;
    const { off, on } = await bothWays(async () => ({
      staff: await textOf('s2'),
      student: await textOf('sg'),
    }));
    expect(off).toEqual({ staff: 'la soirée des promos', student: 'la soirée des promos' });
    // The row stays in the staff officer's bell - the proposal is still theirs to decide - textless.
    expect(on).toEqual({ staff: '', student: 'la soirée des promos' });
  });

  it("FAILS CLOSED: a proposal's bell row loses its text once its post is deleted or hidden (review of #3019)", async () => {
    // Two posts of A1, proposed by mb (a proposer no other case uses) to C2 and to C; the recipient
    // is sg, a student the gate admits - so only the post's fate can take the text away.
    const gone = '00000000-0000-4000-8000-0000000000f3';
    const hidden = '00000000-0000-4000-8000-0000000000f4';
    for (const [id, to, text] of [
      [gone, C2, 'le post supprimé'],
      [hidden, C, 'le post masqué'],
    ] as const) {
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", markdown, "studentsOnly")
           VALUES ($1, 'off', $2, $3, true)`,
        [id, A1, text]
      );
      await q(
        `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "proposedBy")
           VALUES ('repost', $1, $2, $3, 'mb')`,
        [id, A1, to]
      );
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName",
           "associationId", text) VALUES ('sg', 'repost_proposed', $1, 'mb', 'A1', $2, $3)`,
        [to, A1, text]
      );
    }
    const bell = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager } as never,
      {} as never,
      {} as never
    );
    const texts = async () => {
      const rows = (await bell.getNotifications('sg')).filter(
        (n) => n.type === 'repost_proposed' && n.actorId === 'mb'
      );
      return Object.fromEntries(rows.map((n) => [n.postId, n.text]));
    };
    // The switch is ON and sg is a student: both texts are theirs to read.
    expect(await texts()).toEqual({ [C2]: 'le post supprimé', [C]: 'le post masqué' });

    // Deleted: `proposals_drop_deleted_post` takes the proposal with it - nothing matches any more.
    await q(`DELETE FROM posts WHERE id = $1`, [gone]);
    expect(await q(`SELECT 1 FROM proposals WHERE "subjectId" = $1`, [gone])).toHaveLength(0);
    // Hidden by moderation, the proposal still there: the post it leads to is not one to quote.
    await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [hidden]);

    expect(await texts()).toEqual({ [C2]: '', [C]: '' });
  });
});
