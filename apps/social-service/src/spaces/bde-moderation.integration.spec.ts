/**
 * THE SCOPE OF A BDE MODERATOR (owner, 2026-11-02), against a REAL PostgreSQL - migrations 071 and
 * 072 for the spaces, hand-made minimal tables for the rest.
 *
 * `bde-moderation.ts` decides what a BDE `MODERATE` holder may act on: an association's post or live
 * when the BDE is the association's PARENT (WP-R4 on WP-D2), a person's when that person belongs to one
 * of its spaces, a report by what it is about. The unit specs give these answers as fixtures; this
 * file proves the SQL itself.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL` like `bde.integration.spec.ts`; everything happens in a throwaway
 * schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { ModerationController } from '../moderation/moderation.controller';
import { ModerationService } from '../moderation/moderation.service';
import { commentRights, type CommentViewer, type StoredComment } from '../posts/comment-identity';
import {
  BDE_MODERATED_POST_IDS_SQL,
  BDE_MODERATED_USER_IDS_SQL,
  BDE_MODERATES_COMMENT_SQL,
  BDE_MODERATES_LIVE_SQL,
  BDE_MODERATES_REPORT_SQL,
  MODERATION_OUT_OF_SCOPE,
  MODERATION_RESERVED_SQL,
  MODERATION_RESERVED_TO_PLATFORM_ADMIN,
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
  // An INSTITUTION whose rule reaches bdeSe's space: no BDE governs an institution (owner,
  // 2026-11-02/03), so no BDE moderates its content - the platform admin's alone.
  instSe: '00000000-0000-4000-8000-0000000000d1', // institution, rule (NULL, saint-etienne)
  listSe: '00000000-0000-4000-8000-0000000000e1', // a campaign LIST, rule (ICM, saint-etienne)
  // bdeSe's CHILD whose audience reaches only gardanne (bdeGa's spaces): moderated by its parent,
  // never by the BDE of the spaces it reaches (WP-R4).
  clubAway: '00000000-0000-4000-8000-0000000000e2', // rule (ICM, gardanne), parent bdeSe
} as const;

/** The governing parents (WP-D2); clubNone, the BDEs and the institution depend on nobody. */
const PARENT: [string, string][] = [
  [A.clubSe, A.bdeSe],
  [A.clubGa, A.bdeGa],
  [A.listSe, A.bdeSe],
  [A.clubAway, A.bdeSe],
];

const P = {
  clubSePost: '10000000-0000-4000-8000-000000000001',
  clubGaPost: '10000000-0000-4000-8000-000000000002',
  clubNonePost: '10000000-0000-4000-8000-000000000003',
  seStudentPost: '10000000-0000-4000-8000-0000000000a4', // hex letters: its uppercase differs
  gaStudentPost: '10000000-0000-4000-8000-000000000005',
  staffPost: '10000000-0000-4000-8000-000000000006',
  instSePost: '10000000-0000-4000-8000-000000000007',
  // In a BDE's own name. bdeGa's rules also reach bdeSe's space (below), so bdeGaPost is VISIBLE
  // there - and still bdeSe's moderators' to leave alone (owner, 2026-11-03).
  bdeSePost: '10000000-0000-4000-8000-000000000008',
  bdeGaPost: '10000000-0000-4000-8000-000000000009',
  listSePost: '10000000-0000-4000-8000-00000000000b',
  clubAwayPost: '10000000-0000-4000-8000-00000000000d',
} as const;

const L = {
  seLive: '20000000-0000-4000-8000-000000000001', // personal, by seStudent
  gaAssoLive: '20000000-0000-4000-8000-000000000002', // clubGa's
  cutSeLive: '20000000-0000-4000-8000-000000000003', // purged, only its cut is left
} as const;

/**
 * THE MATRIX OF THE OWNER'S RULE OF 2026-11-03: BDE A is bdeSe (seMod), BDE B is bdeGa (gaMod). Each
 * publisher below has a live, and a comment under a post of EACH BDE's scope (seStudent's, A's;
 * gaStudent's, B's), so a comment proves the publisher rule where the place alone would have said yes.
 * `forA` / `forB` are what each BDE's moderator may do to that publisher's content in its own scope.
 */
interface MatrixRow {
  who: string;
  post: string;
  asso: string | null;
  author: string;
  /** The comment of this row is posted anonymously (its account hidden from readers). */
  anonymous?: boolean;
  forA: boolean;
  forB: boolean;
}

const MATRIX: readonly MatrixRow[] = [
  {
    who: "BDE B's name",
    post: P.bdeGaPost,
    asso: A.bdeGa,
    author: 'gaMod',
    forA: false,
    forB: true,
  },
  {
    who: "an institution's name",
    post: P.instSePost,
    asso: A.instSe,
    author: 'seStudent',
    forA: false,
    forB: false,
  },
  {
    who: 'an association A governs',
    post: P.clubSePost,
    asso: A.clubSe,
    author: 'seStudent',
    forA: true,
    forB: false,
  },
  {
    who: 'an association B governs',
    post: P.clubGaPost,
    asso: A.clubGa,
    author: 'gaStudent',
    forA: false,
    forB: true,
  },
  {
    who: 'a list A governs',
    post: P.listSePost,
    asso: A.listSe,
    author: 'seStudent',
    forA: true,
    forB: false,
  },
  {
    who: "a student of A's space",
    post: P.seStudentPost,
    asso: null,
    author: 'seStudent',
    forA: true,
    forB: false,
  },
  {
    // Anonymity hides the account from readers, never from the rule: still a person's comment.
    who: "a student of A's space, anonymously",
    post: P.seStudentPost,
    asso: null,
    author: 'seStudent',
    anonymous: true,
    forA: true,
    forB: false,
  },
];

/** The live of matrix row `i`. */
const matrixLive = (i: number) => `21000000-0000-4000-8000-00000000000${i}`;
/** The comment of matrix row `i` under the post of BDE `bde`'s scope. */
const matrixComment = (bde: 'se' | 'ga', i: number) => `mx-${bde}-${i}`;

/**
 * Under seStudent's post: a student's comment with an INSTITUTION's reply, and one with a club's. The
 * reply never shields what it answers (lead, 2026-11-04): each comment is judged on itself.
 */
const THREAD = {
  instReplied: 'th-inst',
  instReply: 'th-inst-r',
  clubReplied: 'th-club',
  clubReply: 'th-club-r',
} as const;

const matrixComments = (bde: 'se' | 'ga') =>
  MATRIX.map((row, i) => ({
    id: matrixComment(bde, i),
    userId: row.author,
    ...(row.asso ? { associationId: row.asso } : {}),
    ...(row.anonymous ? { anonymous: true } : {}),
  }));

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
        "isBDE" boolean NOT NULL DEFAULT false, type varchar NOT NULL DEFAULT 'association',
        "parentAssociationId" uuid);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions integer NOT NULL DEFAULT 0);
      CREATE TABLE association_calendar_events (id serial PRIMARY KEY, "associationId" uuid NOT NULL);
      CREATE TABLE users (id varchar(255) PRIMARY KEY, campus varchar, cursus jsonb);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255), "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16), "reachSpaces" jsonb,
        comments jsonb);
      CREATE TABLE lives (id uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
      CREATE TABLE live_cuts ("liveId" uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
      CREATE TABLE content_reports (id uuid PRIMARY KEY, "contentType" varchar(30) NOT NULL,
        "contentId" varchar NOT NULL, "reporterId" varchar NOT NULL DEFAULT 'r',
        reason varchar(50) NOT NULL DEFAULT 'spam', details text, status varchar(20) NOT NULL
        DEFAULT 'pending', "reviewedBy" varchar, "reviewedAt" timestamptz, "reportedUserId" varchar,
        "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE live_chat_reported_lines ("reportId" uuid PRIMARY KEY, "liveId" uuid NOT NULL);
      CREATE TABLE post_notifications (id serial PRIMARY KEY, "postId" varchar NOT NULL,
        "commentId" varchar(255), text varchar NOT NULL);
    `);
    for (const [key, id] of Object.entries(A)) {
      const type = key === 'instSe' ? 'institution' : key === 'listSe' ? 'list' : 'association';
      await client.query(
        `INSERT INTO associations (id, name, "isBDE", type) VALUES ($1, $2, $3, $4)`,
        [id, key, key === 'bdeSe', type]
      );
    }
    for (const [child, parent] of PARENT) {
      await client.query(`UPDATE associations SET "parentAssociationId" = $2 WHERE id = $1`, [
        child,
        parent,
      ]);
    }
    await client.query(migration('071_spaces.sql'));
    await client.query(migration('072_drop_is_bde.sql'));
    await client.query(`DELETE FROM association_audiences`);
    const rules: [string, string | null, string][] = [
      [A.bdeSe, 'ICM', 'saint-etienne'],
      [A.bdeGa, 'ICM', 'gardanne'],
      [A.bdeGa, 'ICM', 'saint-etienne'], // bdeGa's posts are seen in bdeSe's space too
      [A.clubSe, 'ICM', 'saint-etienne'],
      [A.clubGa, null, 'gardanne'],
      [A.instSe, null, 'saint-etienne'],
      [A.listSe, 'ICM', 'saint-etienne'],
      [A.clubAway, 'ICM', 'gardanne'],
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
      [
        P.seStudentPost,
        'seStudent',
        null,
        [
          ...matrixComments('se'),
          { id: THREAD.instReplied, userId: 'gaStudent' },
          {
            id: THREAD.instReply,
            userId: 'seStudent',
            associationId: A.instSe,
            parentId: THREAD.instReplied,
          },
          { id: THREAD.clubReplied, userId: 'gaStudent' },
          {
            id: THREAD.clubReply,
            userId: 'seStudent',
            associationId: A.clubSe,
            parentId: THREAD.clubReplied,
          },
        ],
      ],
      [
        P.gaStudentPost,
        'gaStudent',
        null,
        [{ id: 'cm-ga', userId: 'seStudent' }, ...matrixComments('ga')],
      ],
      [P.staffPost, 'staff', null, []],
      [P.instSePost, 'seStudent', A.instSe, []],
      [P.bdeSePost, 'seMod', A.bdeSe, []],
      [P.bdeGaPost, 'gaMod', A.bdeGa, []],
      [P.listSePost, 'seStudent', A.listSe, []],
      [P.clubAwayPost, 'gaStudent', A.clubAway, []],
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
    for (const [i, row] of MATRIX.entries()) {
      await client.query(`INSERT INTO lives VALUES ($1, $2, $3)`, [
        matrixLive(i),
        row.author,
        row.asso,
      ]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('a BDE moderates the posts of its governed spaces, association and personal alike', async () => {
    expect(await posts('seMod')).toEqual(
      [P.clubSePost, P.seStudentPost, P.bdeSePost, P.listSePost, P.clubAwayPost].sort()
    );
    expect(await posts('gaMod')).toEqual([P.clubGaPost, P.gaStudentPost, P.bdeGaPost].sort());
  });

  it("moderates a CHILD's posts wherever its audience reaches, and not the BDE of those spaces (WP-R4)", async () => {
    // clubAway depends on bdeSe and addresses only gardanne, which bdeGa governs.
    expect(await posts('seMod')).toContain(P.clubAwayPost);
    expect(await posts('gaMod')).not.toContain(P.clubAwayPost);
    // A refusal is classified by who CAN act: gaMod's refusal on clubAway is out of scope (its
    // parent moderates it), one on a parentless club is the platform admin's (B2).
    const reserved = async (post: string) =>
      (await client.query(MODERATION_RESERVED_SQL, ['post', post, null])).rows[0]
        .reserved as boolean;
    expect(await reserved(P.clubAwayPost)).toBe(false);
    expect(await reserved(P.clubNonePost)).toBe(true);
    // A hand-written parent on the INSTITUTION (migration 131 refuses one) moderates nothing (G9).
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE associations SET "parentAssociationId" = $2 WHERE id = $1`, [
        A.instSe,
        A.bdeSe,
      ]);
      expect(await posts('seMod')).not.toContain(P.instSePost);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('answers the same for a post id spelled in uppercase (`mayModeratePost`)', async () => {
    // The service on the real query: Postgres answers lowercase ids, so the asked id is lowercased
    // before its `.has()` - otherwise an uppercase id is refused for a post its BDE moderates.
    const service = Object.assign(Object.create(AssociationsService.prototype), {
      memberRepo: {
        query: async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows,
      },
      logger: new Logger('bde-moderation.it'),
    }) as AssociationsService;
    const upper = P.seStudentPost.toUpperCase();
    // Not vacuous: the fixture carries hex letters, so the uppercase spelling is another string.
    expect(upper).not.toBe(P.seStudentPost);
    expect(await service.mayModeratePost('seMod', upper)).toBe(true);
    expect(await service.mayModeratePost('seMod', P.seStudentPost)).toBe(true);
    expect(await service.mayModeratePost('gaMod', upper)).toBe(false);
    // `moderatedPostIds` answers in the lowercase the rows carry, the admin's whole set included -
    // so a page's `.has(row.id)` finds a post asked for in uppercase.
    expect((await service.moderatedPostIds('seMod', [upper])).has(P.seStudentPost)).toBe(true);
    expect(
      (await service.moderatedPostIds(undefined, [upper], { isGlobalAdmin: true })).has(
        P.seStudentPost
      )
    ).toBe(true);
  });

  it('leaves an association with no rule and a person with no space to the platform admin', async () => {
    for (const who of ['seMod', 'gaMod']) {
      const mine = await posts(who);
      expect(mine).not.toContain(P.clubNonePost);
      expect(mine).not.toContain(P.staffPost);
    }
  });

  it("never lets a BDE moderate an institution's post, though its rule reaches the BDE's space", async () => {
    // The institution's rule reaches bdeSe's space (ICM x saint-etienne), as clubSe's does - and
    // clubSe's post IS seMod's. The institution's is nobody's but the platform admin's.
    expect(await posts('seMod')).toContain(P.clubSePost);
    expect(await posts('seMod')).not.toContain(P.instSePost);
    expect(await posts('gaMod')).not.toContain(P.instSePost);
  });

  it("never lets a BDE moderate a post in ANOTHER BDE's name, though it is seen in its spaces (owner, 2026-11-03)", async () => {
    // bdeGa's rules reach bdeSe's space, as clubSe's do; clubSe's post is seMod's, bdeGa's is not.
    expect(await posts('seMod')).toContain(P.clubSePost);
    expect(await posts('seMod')).not.toContain(P.bdeGaPost);
    expect(await posts('gaMod')).not.toContain(P.bdeSePost);
    // Each BDE's own post stays its own moderators'.
    expect(await posts('seMod')).toContain(P.bdeSePost);
    expect(await posts('gaMod')).toContain(P.bdeGaPost);
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
    // The id is cast on the parameter side: either case matches, and a non-uuid matches nothing
    // instead of raising.
    expect(await live('seMod', L.seLive.toUpperCase())).toBe(true);
    expect(await live('seMod', 'not-a-uuid')).toBe(false);
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
      // A free-text contentId that is no uuid: matches nothing, raises nothing.
      ['30000000-0000-4000-8000-000000000009', 'post', 'not-a-uuid'],
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
    expect(await one('seMod', 'not-a-uuid')).toBe(false);
  });

  it('narrows the queue the same through TypeORM, as `ModerationService.listAllReports` builds it', async () => {
    // The service's own query builder, on the real tables: its `:scopeModerator` placeholder and the
    // fragment's `::casts` and regex go through TypeORM's parameter rewriting, which the raw `pg`
    // queries above do not exercise.
    const ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [ContentReport],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    try {
      const queue = async (moderator: string) =>
        (
          await ds
            .getRepository(ContentReport)
            .createQueryBuilder('r')
            .where(reportInBdeScopeSql('r', ':scopeModerator'), { scopeModerator: moderator })
            .orderBy('r.id', 'ASC')
            .getMany()
        ).map((r) => r.id.slice(-1));
      expect(await queue('seMod')).toEqual(['1', '4', '5', '7']);
      expect(await queue('gaMod')).toEqual(['2', '3', '6']);
      expect(await queue('seVal')).toEqual([]);
    } finally {
      await ds.destroy();
    }
  });

  describe("the owner's rule of 2026-11-03: no BDE moderates content in another BDE's or an institution's name", () => {
    /** `AssociationsService` on the real SQL; `isContentModerator` (a query builder) is the door, stubbed open. */
    const service = () =>
      Object.assign(Object.create(AssociationsService.prototype), {
        memberRepo: {
          query: async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows,
        },
        logger: new Logger('bde-moderation.it'),
        isContentModerator: async () => true,
      }) as AssociationsService;
    const comment = async (moderator: string, postId: string, commentId: string) =>
      (await client.query(BDE_MODERATES_COMMENT_SQL, [moderator, postId, commentId])).rows[0]
        .moderates as boolean;
    const live = async (moderator: string, id: string) =>
      (await client.query(BDE_MODERATES_LIVE_SQL, [moderator, id])).rows[0].moderates as boolean;
    const OFFICERS = [
      { officer: 'seMod', bde: 'se', post: P.seStudentPost, expect: 'forA' },
      { officer: 'gaMod', bde: 'ga', post: P.gaStudentPost, expect: 'forB' },
    ] as const;

    it.each(MATRIX.map((row, i) => [row.who, i] as const))(
      "content in %s: a post, a live and a comment under each BDE's own scope",
      async (_who, i) => {
        const row = MATRIX[i];
        for (const { officer, bde, post, expect: key } of OFFICERS) {
          const allowed = row[key];
          // A PERSON's comment is judged by its place alone: under a post of the officer's scope it
          // is the officer's, whoever's student wrote it. An association's is judged by its name.
          const commentAllowed = row.asso === null ? true : allowed;
          // Hide, unhide, unmask, delete, read the anonymous author: `mayModeratePost`'s SQL.
          expect({ officer, post: (await posts(officer)).includes(row.post) }).toEqual({
            officer,
            post: allowed,
          });
          // Cut a live, hide a line of its chat: `mayModerateLive`'s SQL.
          expect({ officer, live: await live(officer, matrixLive(i)) }).toEqual({
            officer,
            live: allowed,
          });
          // Delete a comment (the route and the served bin): under a post of the officer's OWN
          // scope, so the place alone would say yes - the publisher is what is judged.
          expect({ officer, comment: await comment(officer, post, matrixComment(bde, i)) }).toEqual(
            { officer, comment: commentAllowed }
          );
        }
      }
    );

    it("never reaches a comment under the OTHER BDE's post, whoever publishes it", async () => {
      for (const i of MATRIX.keys()) {
        expect(await comment('seMod', P.gaStudentPost, matrixComment('ga', i))).toBe(false);
        expect(await comment('gaMod', P.seStudentPost, matrixComment('se', i))).toBe(false);
      }
    });

    it("judges a student's comment on itself: an institution's reply does not shield it (lead, 2026-11-04)", async () => {
      expect(await comment('seMod', P.seStudentPost, THREAD.instReplied)).toBe(true);
      // The reply itself stays the platform admin's.
      expect(await comment('seMod', P.seStudentPost, THREAD.instReply)).toBe(false);
      // The same thread with a reply by a club A governs is A's.
      expect(await comment('seMod', P.seStudentPost, THREAD.clubReplied)).toBe(true);
      expect(await comment('seMod', P.seStudentPost, THREAD.clubReply)).toBe(true);
    });

    it('serves the same bin as the route answers: `commentRights` on the real publisher set', async () => {
      // The in-memory twin (`moderatesComment`) must agree with `BDE_MODERATES_COMMENT_SQL` on
      // every comment of the post, or a moderator would see a bin the route refuses.
      const svc = service();
      const stored = (
        await client.query(`SELECT comments FROM posts WHERE id = $1`, [P.seStudentPost])
      ).rows[0].comments as StoredComment[];
      for (const officer of ['seMod', 'gaMod']) {
        const v: CommentViewer = {
          viewerId: officer,
          isGlobalAdmin: false,
          isModerator: await svc.mayModeratePost(officer, P.seStudentPost),
          managedAssociationIds: new Set(),
          moderatedAssociationIds: await svc.moderatedAssociationIds(
            officer,
            stored.map((c) => c.associationId ?? '').filter(Boolean)
          ),
        };
        for (const c of stored) {
          const served = commentRights(c, v).canDelete;
          expect({ officer, id: c.id, served }).toEqual({
            officer,
            id: c.id,
            served: await comment(officer, P.seStudentPost, c.id ?? ''),
          });
        }
      }
    });

    it('narrows the report queue to what the BDE may act on - an escalated item is not listed', async () => {
      const reports: [string, string, string][] = [
        ['31000000-0000-4000-8000-000000000001', 'post', P.instSePost],
        ['31000000-0000-4000-8000-000000000002', 'post', P.bdeGaPost],
        ['31000000-0000-4000-8000-000000000003', 'comment', matrixComment('se', 1)], // institution
        ['31000000-0000-4000-8000-000000000004', 'comment', matrixComment('se', 0)], // BDE B
        ['31000000-0000-4000-8000-000000000005', 'comment', matrixComment('se', 2)], // club A
        ['31000000-0000-4000-8000-000000000006', 'comment', THREAD.instReplied],
        ['31000000-0000-4000-8000-000000000007', 'live', matrixLive(1)], // institution
        ['31000000-0000-4000-8000-000000000008', 'live', matrixLive(2)], // club A
      ];
      for (const [id, type, contentId] of reports) {
        await client.query(
          `INSERT INTO content_reports (id, "contentType", "contentId") VALUES ($1, $2, $3)`,
          [id, type, contentId]
        );
      }
      const mine = async (moderator: string) =>
        (
          await client.query(
            `SELECT r.id FROM content_reports r WHERE r.id::text LIKE '31%' AND ${reportInBdeScopeSql('r', '$1')} ORDER BY r.id`,
            [moderator]
          )
        ).rows.map((r) => (r.id as string).slice(-1));
      // 6 is a student's comment under an institution's reply: the student's comment is A's.
      expect(await mine('seMod')).toEqual(['5', '6', '8']);
      // BDE B sees its own post's report and nothing under A's student's post.
      expect(await mine('gaMod')).toEqual(['2']);
      const svc = service();
      for (const [id] of reports) {
        // Reviewing follows the queue, and the platform admin reviews every one.
        expect(await svc.mayModerateReport(undefined, id, { isGlobalAdmin: true })).toBe(true);
      }
      expect(await svc.mayModerateReport('seMod', reports[0][0])).toBe(false);
      expect(await svc.mayModerateReport('seMod', reports[4][0])).toBe(true);
    });

    it('classifies the refusal at the throw: reserved to the platform admin, or out of scope', async () => {
      const reserved = async (kind: string, id: string, postId: string | null = null) =>
        (await client.query(MODERATION_RESERVED_SQL, [kind, id, postId])).rows[0]
          .reserved as boolean;
      expect(await reserved('post', P.instSePost)).toBe(true);
      expect(await reserved('post', P.bdeGaPost)).toBe(true);
      expect(await reserved('post', P.clubGaPost)).toBe(false);
      expect(await reserved('live', matrixLive(1))).toBe(true);
      expect(await reserved('live', matrixLive(3))).toBe(false);
      expect(await reserved('comment', matrixComment('se', 1), P.seStudentPost)).toBe(true);
      expect(await reserved('comment', matrixComment('se', 3), P.seStudentPost)).toBe(false);
      expect(await reserved('comment', THREAD.instReplied)).toBe(false);
      expect(await reserved('comment', THREAD.instReply)).toBe(true);
      expect(await reserved('report', '31000000-0000-4000-8000-000000000001')).toBe(true);
      expect(await reserved('post', 'not-a-uuid')).toBe(false);

      const svc = service();
      const codeOf = async (target: Parameters<AssociationsService['refuseModeration']>[1]) => {
        const refusal = await svc.refuseModeration('seMod', target).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        return ((refusal as ForbiddenException).getResponse() as { code: string }).code;
      };
      expect(await codeOf({ kind: 'post', id: P.instSePost })).toBe(
        MODERATION_RESERVED_TO_PLATFORM_ADMIN
      );
      expect(await codeOf({ kind: 'post', id: P.bdeGaPost })).toBe(
        MODERATION_RESERVED_TO_PLATFORM_ADMIN
      );
      expect(await codeOf({ kind: 'comment', id: THREAD.instReply, postId: P.seStudentPost })).toBe(
        MODERATION_RESERVED_TO_PLATFORM_ADMIN
      );
      expect(await codeOf({ kind: 'post', id: P.clubGaPost })).toBe(MODERATION_OUT_OF_SCOPE);
      expect(await codeOf({ kind: 'user', id: 'gaStudent' })).toBe(MODERATION_OUT_OF_SCOPE);
    });

    it('leaves the platform admin global over every row of the matrix', async () => {
      const svc = service();
      const admin = { isGlobalAdmin: true };
      const allPosts = MATRIX.map((r) => r.post);
      expect([...(await svc.moderatedPostIds('admin', allPosts, admin))].sort()).toEqual(
        [...new Set(allPosts)].sort()
      );
      for (const i of MATRIX.keys()) {
        expect(await svc.mayModerateLive('admin', matrixLive(i), admin)).toBe(true);
        for (const { bde, post } of OFFICERS) {
          expect(await svc.mayModerateComment('admin', post, matrixComment(bde, i), admin)).toBe(
            true
          );
        }
      }
      const publishers: string[] = MATRIX.flatMap((r) => (r.asso ? [r.asso] : []));
      expect([...(await svc.moderatedAssociationIds('admin', publishers, admin))].sort()).toEqual(
        [...publishers].sort()
      );
      // And the served bin: an admin deletes an institution's comment.
      const v: CommentViewer = {
        isGlobalAdmin: true,
        isModerator: true,
        managedAssociationIds: new Set(),
        moderatedAssociationIds: new Set(),
      };
      const institutional = { id: THREAD.instReply, userId: 'seStudent', associationId: A.instSe };
      expect(commentRights(institutional, v).canDelete).toBe(true);
    });

    it('tombstones what a protected reply answers, takes what it moderates, at every level (lead, 2026-11-04)', async () => {
      // The route itself (`POST /moderation/comments/:id/delete`) on the real tables: the door
      // (`mayModerateComment`), the publisher set, the plan and the stored jsonb.
      const post = '10000000-0000-4000-8000-00000000000c';
      const thread: StoredComment[] = [
        { id: 'tb-root', userId: 'gaStudent', text: 'root', media: { mediaId: 'm-root' } },
        { id: 'tb-inst', parentId: 'tb-root', userId: 'seStudent', associationId: A.instSe },
        { id: 'tb-bdeB', parentId: 'tb-root', userId: 'gaMod', associationId: A.bdeGa },
        { id: 'tb-club', parentId: 'tb-root', userId: 'seStudent', associationId: A.clubSe },
        { id: 'tb-st', parentId: 'tb-root', userId: 'seStudent', text: 'student' },
        { id: 'tb-st-inst', parentId: 'tb-st', userId: 'seStudent', associationId: A.instSe },
        { id: 'tb-st-anon', parentId: 'tb-st', userId: 'gaStudent', anonymous: true },
      ];
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId", comments) VALUES ($1, 'seStudent', NULL, $2)`,
        [post, JSON.stringify(thread)]
      );
      // The bell: one row about the club reply the delete takes, one about the root it tombstones,
      // one about the institution's reply it keeps.
      for (const [commentId, text] of [
        ['tb-club', 'club words'],
        ['tb-root', 'root words'],
        ['tb-inst', 'inst words'],
      ]) {
        await client.query(
          `INSERT INTO post_notifications ("postId", "commentId", text) VALUES ($1, $2, $3)`,
          [post, commentId, text]
        );
      }
      // The media service, as `applyMediaRetentionClass` calls it.
      const released: string[] = [];
      const http = {
        post: jest.fn((_url: string, body: { mediaIds: string[] }) => {
          released.push(...body.mediaIds);
          return of({ data: { changed: body.mediaIds.length } });
        }),
      };
      const ds = new DataSource({
        type: 'postgres',
        url: URL,
        entities: [ContentReport],
        synchronize: false,
        extra: { options: `-c search_path=${schema},public` },
      });
      await ds.initialize();
      try {
        const route = new ModerationController(
          new ModerationService(ds.getRepository(ContentReport), {} as never, http as never),
          service()
        );
        const stored = async () =>
          (await client.query(`SELECT comments FROM posts WHERE id = $1`, [post])).rows[0]
            .comments as StoredComment[];

        // The institution's reply is refused at the door, typed, and nothing moves.
        const refusal = await route
          .deleteReportedComment('tb-inst', 'seMod', undefined)
          .catch((e: unknown) => e);
        expect((refusal as ForbiddenException).getResponse()).toMatchObject({
          code: MODERATION_RESERVED_TO_PLATFORM_ADMIN,
        });
        expect(await stored()).toEqual(thread);

        // The student's root is A's: it goes, as does every descendant A moderates; what A does not
        // moderate (an institution's, BDE B's) stays, under tombstones of what it answered.
        const done = await route.deleteReportedComment('tb-root', 'seMod', undefined);
        expect([...done.removedIds].sort()).toEqual(['tb-club', 'tb-st-anon']);
        expect([...done.tombstoneIds].sort()).toEqual(['tb-root', 'tb-st']);
        const after = await stored();
        expect(after.map((c) => c.id)).toEqual([
          'tb-root',
          'tb-inst',
          'tb-bdeB',
          'tb-st',
          'tb-st-inst',
        ]);
        const root = after[0];
        expect(root).toMatchObject({ id: 'tb-root', text: '', removedByModeration: true });
        expect(root.media).toBeUndefined();
        expect(after[3]).toMatchObject({ id: 'tb-st', text: '', removedByModeration: true });
        // A tombstone names nobody: a block with its writer could otherwise probe who it was.
        expect(after.filter((c) => c.removedByModeration).map((c) => c.userId)).toEqual([
          undefined,
          undefined,
        ]);
        // The media of what the moderation took are released, as on the comment's own route.
        expect(released).toEqual(['m-root']);
        // The bell forgets the removed reply and blanks the tombstoned root's preview.
        const bell = (
          await client.query(
            `SELECT "commentId", text FROM post_notifications WHERE "postId" = $1 ORDER BY "commentId"`,
            [post]
          )
        ).rows;
        expect(bell).toEqual([
          { commentId: 'tb-inst', text: 'inst words' },
          { commentId: 'tb-root', text: '' },
        ]);

        // A tombstone left with no reply goes with the last thing it was kept for.
        await route.deleteReportedComment('tb-st-inst', 'admin', 'true');
        expect((await stored()).map((c) => c.id)).toEqual(['tb-root', 'tb-inst', 'tb-bdeB']);
        await route.deleteReportedComment('tb-inst', 'admin', 'true');
        await route.deleteReportedComment('tb-bdeB', 'admin', 'true');
        expect(await stored()).toEqual([]);
      } finally {
        await ds.destroy();
      }
    });
  });
});
