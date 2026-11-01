/**
 * A PERSONAL POST REPUBLISHED WITH ITS AUTHOR'S CONSENT (D38b), against a REAL PostgreSQL -
 * migrations 071, 072, 073, 078 and 096 applied.
 *
 * Drives `PersonalRepublicationsService` (the `repost-personal` kind) and the generic
 * `ProposalsService` through a real TypeORM connection, so the CHECKs, the unique index on the
 * proposing association, the advisory-locked caps, the conditional decision and the transaction
 * around `apply` are PostgreSQL's. Association rights come from the members table (a stand-in for
 * `mayAct` reading the same bit), moderation is a set of muted ids, and notifications are recorded.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- personal-republications.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import type { AssociationsService } from '../associations/associations.service';
import type { RedisService } from '../common/redis/redis.service';
import {
  ERASURE_ASSOCIATION_LOCK_SQL,
  ERASURE_STATEMENTS,
  type ErasureDb,
  eraseSocialRows,
} from '../internal/account-erasure';
import type { ModerationService } from '../moderation/moderation.service';
import { Proposal, PROPOSAL_VOIDED_BY } from '../proposals/proposal.entity';
import { PROPOSAL_SENDER_GONE, ProposalsService } from '../proposals/proposals.service';
import { postVisibleToViewerSql } from '../spaces/reader-spaces';
import { PostRepublication } from './entities/post-republication.entity';
import {
  MAX_PENDING_REQUESTS_PER_ASSOCIATION,
  MAX_PENDING_REQUESTS_PER_AUTHOR,
  PERSONAL_REPOST_CODES,
  PersonalRepublicationsService,
} from './personal-republications.service';
import type { PostNotificationsService } from './post-notifications.service';
import { PostsService } from './posts.service';
import { dropRepublicationsOf } from './republication-sql';
import { RepublicationsService } from './republications.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** The tables built only for the erasure's association lock: no erasure statement runs on them. */
const LOCK_ONLY = new Set([
  'association_role_history',
  'association_push_mutes',
  'association_calendar_events',
  'forms',
  'form_respondents',
  'booking_spaces',
  'booking_resources',
  'bookings',
  'booking_participants',
  'booking_blocks',
  'booking_files',
]);

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;

/** The cast. Readable ids: a failure names a person. */
const USERS: Record<string, { campus: string | null; formation: string | null; name: string }> = {
  // The AUTHOR of the personal posts (ICM Saint-Etienne).
  au: { campus: 'saint-etienne', formation: 'ICM', name: 'Alice Author' },
  // The PROPOSER: an ICM Saint-Etienne student (sees au's posts) who publishes for AG and AG2.
  pr: { campus: 'saint-etienne', formation: 'ICM', name: 'Paul Proposer' },
  // Gardanne readers of AG: a plain one, one who FOLLOWS au, one who BLOCKED au.
  gr: { campus: 'gardanne', formation: 'ISMIN', name: 'Gina Reader' },
  gf: { campus: 'gardanne', formation: 'ISMIN', name: 'Gus Follower' },
  gb: { campus: 'gardanne', formation: 'ISMIN', name: 'Gil Blocker' },
  // A Gardanne officer of AG who cannot see au's posts (no shared space).
  outsider: { campus: 'gardanne', formation: 'ISMIN', name: 'Olga Outsider' },
  // An ICM Saint-Etienne reader with no right anywhere.
  plain: { campus: 'saint-etienne', formation: 'ICM', name: 'Pia Plain' },
  // An author au's proposer has blocked.
  bl: { campus: 'saint-etienne', formation: 'ICM', name: 'Bob Blocked' },
  // An author whose account is restricted.
  mu: { campus: 'saint-etienne', formation: 'ICM', name: 'Mia Muted' },
  // A second officer of AG2, who asks after the first one stopped speaking for it.
  pr2: { campus: 'saint-etienne', formation: 'ICM', name: 'Pat Second' },
  // An officer of AG who asks, reacts to a post, and is then erased.
  er: { campus: 'saint-etienne', formation: 'ICM', name: 'Eve Erased' },
};

const A = (n: number) => `00000000-0000-4000-8000-0000000b${String(n).padStart(4, '0')}`;
const AG = A(1); // association, Gardanne
const AG2 = A(2); // association, Gardanne, for the association cap
const INST = A(3); // institution
const LIST = A(4); // promo list
const ARCH = A(5); // archived association
const A1 = A(6); // association of an association post
const AG3 = A(7); // association, deleted while a request of it is being accepted

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POSTS: {
  id: string;
  authorId: string;
  associationId?: string;
  anonymous?: boolean;
  hidden?: boolean;
  announced?: boolean;
}[] = [
  { id: P(1), authorId: 'au', announced: true }, // accepted, then withdrawn by the author
  { id: P(2), authorId: 'au', anonymous: true, announced: true },
  { id: P(3), authorId: 'au', hidden: true, announced: true },
  { id: P(4), authorId: 'au', announced: false }, // accepted before its first announce
  { id: P(5), authorId: 'bl', announced: true }, // a block with the proposer
  { id: P(6), authorId: 'au', associationId: A1, announced: true },
  { id: P(7), authorId: 'au', announced: true }, // refused
  { id: P(8), authorId: 'au', announced: true }, // withdrawn by the association, asked again
  { id: P(9), authorId: 'au', announced: true }, // hidden while pending
  { id: P(10), authorId: 'mu', announced: true }, // a muted author accepts
  { id: P(11), authorId: 'pr', announced: true }, // the proposer's own
  { id: P(12), authorId: 'au', announced: true }, // the caps
  { id: P(13), authorId: 'au', announced: true }, // its asker stops speaking for the association
  { id: P(14), authorId: 'au', announced: true }, // the lock order of an acceptance
  { id: P(15), authorId: 'au', announced: true }, // becomes an expired reel
  { id: P(16), authorId: 'au', announced: true }, // its asker is erased while it is accepted
  { id: P(17), authorId: 'au', announced: true }, // a silenced asker's request, asked again
  { id: P(18), authorId: 'au', announced: true }, // the caps leave a silenced asker out
  { id: P(19), authorId: 'au', announced: true }, // its association is deleted during acceptance
];

/** A refusal's stable code, read from the exception's body the way the client reads it. */
function codeOf(err: unknown): string | undefined {
  if (!(err instanceof HttpException)) return undefined;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
}

async function refusedWith(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

maybe('personal republication by consent against PostgreSQL (migration 096)', () => {
  const schema = `repost_p_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let republications: RepublicationsService;
  let personal: PersonalRepublicationsService;
  let proposals: ProposalsService;
  const told: {
    type: string;
    postId: string;
    actorId: string;
    recipientIds: string[];
    pushData?: Record<string, string>;
    skipPush?: boolean;
  }[] = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function holds(userId: string, associationId: string, flag: number): Promise<boolean> {
    const rows: unknown[] = await q(
      `SELECT 1 FROM association_members WHERE "userId" = $1 AND "associationId" = $2 AND (permissions & $3) <> 0`,
      [userId, associationId, flag]
    );
    return rows.length > 0;
  }

  async function muted(userId: string): Promise<boolean> {
    const rows: unknown[] = await q(
      `SELECT 1 FROM user_moderation WHERE "userId" = $1 AND "isMuted" = true`,
      [userId]
    );
    return rows.length > 0;
  }

  async function setMuted(userId: string, isMuted: boolean): Promise<void> {
    await q(
      `INSERT INTO user_moderation ("userId", "isMuted") VALUES ($1, $2)
       ON CONFLICT ("userId") DO UPDATE SET "isMuted" = EXCLUDED."isMuted"`,
      [userId, isMuted]
    );
  }

  async function setFlag(userId: string, associationId: string, permissions: number) {
    await q(
      `UPDATE association_members SET permissions = $3 WHERE "userId" = $1 AND "associationId" = $2`,
      [userId, associationId, permissions]
    );
  }

  /**
   * Resolves once at least `n` backends of this database wait on a lock - how a two-connection case
   * knows a transaction has REACHED its wait, rather than guessing a duration.
   */
  async function lockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const rows: { n: number }[] = await q(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if (rows[0].n >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const seen: unknown[] = await q(
      `SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`
    );
    throw new Error(`never ${n} backend(s) waiting on a lock: ${JSON.stringify(seen)}`);
  }

  async function sees(postId: string, userId: string): Promise<boolean> {
    const rows: { visible: boolean }[] = await q(
      `SELECT ${postVisibleToViewerSql('posts', '$2')} AS visible FROM posts WHERE posts.id = $1`,
      [postId, userId]
    );
    return rows[0]?.visible === true;
  }

  async function proposalOf(postId: string, from: string) {
    const rows: Proposal[] = await q(
      `SELECT * FROM proposals WHERE kind = 'repost-personal' AND "subjectId" = $1 AND "fromAssociationId" = $2
        ORDER BY "createdAt" DESC`,
      [postId, from]
    );
    return rows[0];
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Proposal, PostRepublication],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "logoUrl" varchar, "logoMediaId" varchar, "isBDE" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(255));
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, markdown text,
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NOT NULL DEFAULT now(),
        reactions jsonb NOT NULL DEFAULT '{}', mentions text NOT NULL DEFAULT '',
        comments jsonb NOT NULL DEFAULT '[]', polls jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false, "mutedBy" varchar(255));
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE post_notifications (id serial PRIMARY KEY, "recipientId" varchar NOT NULL,
        type varchar NOT NULL, "postId" varchar NOT NULL, "associationId" uuid, "actorId" varchar);
    `);
    // Only what the erasure's association lock reads (`LOCK_ONLY`): no statement runs against them.
    await q(`
      CREATE TABLE association_role_history (association_id uuid, user_id varchar);
      CREATE TABLE association_push_mutes ("associationId" uuid, "userId" varchar);
      CREATE TABLE association_calendar_events ("associationId" uuid, "createdBy" varchar,
        "validatedBy" varchar, "rejectedBy" varchar);
      CREATE TABLE forms (id uuid PRIMARY KEY, "associationId" uuid, "ownerId" varchar);
      CREATE TABLE form_respondents ("formId" uuid, "userId" varchar);
      CREATE TABLE booking_spaces (id uuid PRIMARY KEY, "associationId" uuid, "ownerId" varchar);
      CREATE TABLE booking_resources (id uuid PRIMARY KEY, "spaceId" uuid, "linkedUserId" varchar);
      CREATE TABLE bookings (id uuid PRIMARY KEY, "resourceId" uuid, "holderId" varchar,
        "bookedById" varchar, "cancelledById" varchar);
      CREATE TABLE booking_participants ("bookingId" uuid, "userId" varchar);
      CREATE TABLE booking_blocks ("resourceId" uuid, "createdById" varchar);
      CREATE TABLE booking_files ("spaceId" uuid, "uploaderId" varchar);
    `);
    await q(
      `INSERT INTO associations (id, name, slug, type, archived) VALUES
         ($1, 'AG', 'ag', 'association', false), ($2, 'AG2', 'ag2', 'association', false),
         ($3, 'INST', 'inst', 'institution', false), ($4, 'LIST', 'list', 'list', false),
         ($5, 'ARCH', 'arch', 'association', true), ($6, 'A1', 'a1', 'association', false),
         ($7, 'AG3', 'ag3', 'association', false)`,
      [AG, AG2, INST, LIST, ARCH, A1, AG3]
    );
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('096_personal_republication_requests.sql'));
    // AG and AG2 reach the whole Gardanne campus, and nothing else.
    for (const id of [AG, AG2]) {
      await q(`DELETE FROM association_audiences WHERE "associationId" = $1`, [id]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
        [id]
      );
    }
    for (const [id, u] of Object.entries(USERS)) {
      const [firstName, lastName] = u.name.split(' ');
      await q(
        `INSERT INTO users (id, campus, cursus, "firstName", "lastName") VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          u.campus,
          JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : []),
          firstName,
          lastName,
        ]
      );
    }
    for (const asso of [AG, AG2, INST, LIST, ARCH, AG3]) {
      await q(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, 'pr', $2)`,
        [asso, POST_AS]
      );
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId", permissions) VALUES
         ($1, 'outsider', $2), ($3, 'au', $2), ($4, 'pr2', $2), ($1, 'er', $2), ($4, 'filler', $2)`,
      [AG, POST_AS, A1, AG2]
    );
    await q(`INSERT INTO user_moderation ("userId", "isMuted") VALUES ('mu', true)`);
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('gb', 'au'), ('pr', 'bl')`);
    // gf follows au; gr only ASKED to (WP-F1), and a request is not a follow.
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status)
         VALUES ('gf', 'au', 'accepted'), ('gr', 'au', 'pending')`
    );
    for (const p of POSTS) {
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", anonymous, "hiddenByModeration", markdown, "feedNotifiedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          p.id,
          p.authorId,
          p.associationId ?? null,
          p.anonymous ?? false,
          p.hidden ?? false,
          `post ${p.id.slice(-2)}`,
          p.announced ? new Date() : null,
        ]
      );
    }

    const associations = {
      mayAct: (userId: string, associationId: string, flag: number) =>
        holds(userId, associationId, flag),
      canPostAs: (userId: string, associationId: string) => holds(userId, associationId, POST_AS),
    } as unknown as AssociationsService;
    const notifications = {
      createNotifications: (data: (typeof told)[number]) => {
        const recipientIds = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
        told.push({ ...data, recipientIds: recipientIds.sort() });
        return Promise.resolve(recipientIds.length);
      },
    } as unknown as PostNotificationsService;
    // The table `senderSpeaksSql` reads, and what `ModerationService.isUserMuted` reads too.
    const moderation = {
      isUserMuted: (id: string) => muted(id),
    } as unknown as ModerationService;
    const redis = { deleteByPattern: () => Promise.resolve(0) } as unknown as RedisService;
    proposals = new ProposalsService(ds.getRepository(Proposal), associations);
    republications = new RepublicationsService(
      ds.getRepository(PostRepublication),
      associations,
      notifications,
      redis,
      proposals
    );
    republications.onModuleInit();
    personal = new PersonalRepublicationsService(
      ds.getRepository(PostRepublication),
      republications,
      notifications,
      moderation,
      proposals
    );
    personal.onModuleInit();
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  beforeEach(() => {
    told.length = 0;
  });

  /**
   * THE CARD OFFERS WHAT THE WRITE ACCEPTS: `PostsService`'s page-wide predicate (one query for a
   * whole feed) against the same rows the refusals above are proven on - before any request exists.
   */
  describe("the card's offer", () => {
    type Context = {
      personalRepublishAsIds: Set<string>;
      requestablePersonalIds: Set<string>;
    };
    async function offerFor(viewerId: string, postIds: string[]): Promise<Context> {
      const posts = new PostsService(
        { manager: ds.manager } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
      ) as unknown as {
        republishAsOf(id: string): Promise<{ personal: Set<string> }>;
        personalRequestContext(ids: string[], id: string, as: Set<string>): Promise<Context>;
      };
      const memberships = await posts.republishAsOf(viewerId);
      return posts.personalRequestContext(postIds, viewerId, memberships.personal);
    }

    it('names only associations of the kind that may ask, and only the posts a request would pass', async () => {
      const offer = await offerFor('pr', [P(1), P(2), P(3), P(5), P(11), P(12)]);
      expect([...offer.personalRepublishAsIds].sort()).toEqual([AG, AG2, AG3].sort());
      // Anonymous (2), hidden (3), a block (5) and the proposer's own (11) are left out.
      expect([...offer.requestablePersonalIds].sort()).toEqual([P(1), P(12)].sort());
    });

    it('serves a standing request, named, and forgets it once the association withdraws it', async () => {
      const asked = await personal.request(P(1), AG2, 'pr');
      const standing = await offerFor('pr', [P(1)]);
      expect(
        (standing as unknown as { personalRequests: Map<string, unknown[]> }).personalRequests.get(
          P(1)
        )
      ).toEqual([
        {
          associationId: AG2,
          associationName: expect.any(String),
          proposalId: asked.id,
          status: 'pending',
        },
      ]);
      await proposals.withdraw(asked.id, 'pr', false);
      const after = await offerFor('pr', [P(1)]);
      expect(
        (after as unknown as { personalRequests: Map<string, unknown[]> }).personalRequests.size
      ).toBe(0);
      // The withdrawn row is history the later tests do not expect: they start from no row at all.
      await q(`DELETE FROM proposals WHERE id = $1`, [asked.id]);
    });

    it('offers nothing on an expired reel, which a request would refuse as withheld', async () => {
      await q(
        `UPDATE posts SET kind = 'reel', "expiresAt" = now() - interval '1 hour' WHERE id = $1`,
        [P(15)]
      );
      const offer = await offerFor('pr', [P(15)]);
      expect(offer.requestablePersonalIds.size).toBe(0);
      await expect(personal.request(P(15), AG, 'pr')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('offers nothing on a post the reader does not see', async () => {
      const offer = await offerFor('outsider', [P(1)]);
      expect([...offer.personalRepublishAsIds]).toEqual([AG]);
      expect(offer.requestablePersonalIds.size).toBe(0);
    });
  });

  describe('what may not be asked', () => {
    it('a post the proposer cannot see is a 404, before anything about it is confirmed', async () => {
      expect(await sees(P(2), 'outsider')).toBe(false);
      // P(2) is ANONYMOUS: the outsider must not learn even that.
      const err = await refusedWith(personal.request(P(2), AG, 'outsider'));
      expect(err).toBeInstanceOf(NotFoundException);
    });

    it('an anonymous post is refused with its code: an association beside it would unmask it', async () => {
      const err = await refusedWith(personal.request(P(2), AG, 'pr'));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(PERSONAL_REPOST_CODES.anonymous);
    });

    it('an association post, the proposer own post and a hidden post are refused', async () => {
      // pr sees A1's post through its default (ICM, saint-etienne) rule.
      expect(codeOf(await refusedWith(personal.request(P(6), AG, 'pr')))).toBe(
        PERSONAL_REPOST_CODES.notPersonal
      );
      expect(codeOf(await refusedWith(personal.request(P(11), AG, 'pr')))).toBe(
        PERSONAL_REPOST_CODES.ownPost
      );
      expect(await refusedWith(personal.request(P(3), AG, 'pr'))).toBeInstanceOf(NotFoundException);
    });

    it('only an association, not archived, may ask - never an institution or a list', async () => {
      for (const asso of [INST, LIST, ARCH]) {
        expect(codeOf(await refusedWith(personal.request(P(1), asso, 'pr')))).toBe(
          PERSONAL_REPOST_CODES.associationType
        );
      }
    });

    it('the proposer must HOLD POST_AS_ASSO in the association (403)', async () => {
      expect(await refusedWith(personal.request(P(1), AG, 'plain'))).toBeInstanceOf(
        ForbiddenException
      );
    });

    it('a block either way between the proposer and the author is a 403 with its code', async () => {
      const err = await refusedWith(personal.request(P(5), AG, 'pr'));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(PERSONAL_REPOST_CODES.blocked);
    });

    it('nothing above wrote a row', async () => {
      expect(await q(`SELECT 1 FROM proposals`)).toEqual([]);
      expect(told).toEqual([]);
    });
  });

  describe('ask, see, accept, withdraw', () => {
    it('stores a pending request, tells the AUTHOR with a typed tap target, and shows nothing yet', async () => {
      const proposal = await personal.request(P(1), AG, 'pr');
      expect(proposal).toMatchObject({
        kind: 'repost-personal',
        status: 'pending',
        fromAssociationId: AG,
        toAssociationId: null,
        toUserId: 'au',
        proposedBy: 'pr',
      });
      expect(told).toEqual([
        expect.objectContaining({
          type: 'repost_personal_requested',
          postId: P(1),
          recipientIds: ['au'],
          pushData: { target: 'republication-requests' },
        }),
      ]);
      expect(await sees(P(1), 'gr')).toBe(false);
    });

    it('a second request from the same association is a 409', async () => {
      await expect(personal.request(P(1), AG, 'pr')).rejects.toBeInstanceOf(ConflictException);
    });

    it("the author's inbox names who asks, for which association, and how many readers it would add", async () => {
      const { incoming } = await personal.inbox('au');
      expect(incoming).toHaveLength(1);
      expect(incoming[0]).toMatchObject({
        subjectId: P(1),
        from: { id: AG, name: 'AG' },
        proposedBy: { id: 'pr', name: 'Paul Proposer' },
        // gr, gb and outsider see AG and not the post (pr already does: shared space; gf too, as
        // au's ACCEPTED follower, WP-F5). EXACTLY whom acceptance would tell: gr and outsider -
        // never gb, who blocked au, and never gf, who reads it already.
        details: { preview: 'post 01', newlyReached: 2 },
      });
      // Nobody else reads it.
      expect((await personal.inbox('pr')).incoming).toEqual([]);
    });

    it("the association's queue shows it as outgoing, with the person it waits on", async () => {
      const queue = await proposals.listPending(AG, 'pr', false);
      expect(queue.outgoing).toEqual([
        expect.objectContaining({
          kind: 'repost-personal',
          subjectId: P(1),
          to: null,
          toUser: { id: 'au', name: 'Alice Author' },
        }),
      ]);
      expect(queue.incoming).toEqual([]);
    });

    it('an officer of the association who cannot see the post learns neither its text nor whose it is', async () => {
      expect(await sees(P(1), 'outsider')).toBe(false);
      const queue = await proposals.listPending(AG, 'outsider', false);
      expect(queue.outgoing).toEqual([
        expect.objectContaining({
          kind: 'repost-personal',
          subjectId: null,
          subject: null,
          toUser: null,
        }),
      ]);
      expect(JSON.stringify(queue)).not.toContain('Alice');
      expect(JSON.stringify(queue)).not.toContain('post 01');
      // Not even the post's id: `/posts/:id` would answer what the queue withheld.
      expect(JSON.stringify(queue)).not.toContain(P(1));
    });

    it('only the author decides: neither the proposer nor a global admin', async () => {
      const proposal = await proposalOf(P(1), AG);
      await expect(proposals.accept(proposal.id, 'pr', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(proposals.accept(proposal.id, 'plain', true)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(proposals.refuse(proposal.id, 'plain', true)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('acceptance republishes, tells the newly reached once - never across a block - and the proposer', async () => {
      const proposal = await proposalOf(P(1), AG);
      const accepted = await proposals.accept(proposal.id, 'au', false);
      expect(accepted).toMatchObject({ status: 'accepted', decidedBy: 'au' });
      expect(await sees(P(1), 'gr')).toBe(true);
      const rows: { republishedBy: string }[] = await q(
        `SELECT "republishedBy" FROM post_republications WHERE "postId" = $1 AND "associationId" = $2`,
        [P(1), AG]
      );
      expect(rows).toEqual([{ republishedBy: 'pr' }]);
      expect(told).toEqual([
        // Announced already: every newly reached reader but the one who blocked the author - and
        // not gf, au's accepted follower, who saw the post before it was carried (WP-F5).
        expect.objectContaining({
          type: 'association_repost',
          postId: P(1),
          recipientIds: ['gr', 'outsider'],
        }),
        expect.objectContaining({
          type: 'repost_personal_accepted',
          recipientIds: ['pr'],
          skipPush: true,
        }),
      ]);
    });

    it('the author withdraws it at any time; it then stands as a refusal and cannot be asked again', async () => {
      await republications.unrepublish(P(1), AG, 'au', false);
      expect(await sees(P(1), 'gr')).toBe(false);
      expect(await proposalOf(P(1), AG)).toMatchObject({ status: 'refused', decidedBy: 'au' });
      await expect(personal.request(P(1), AG, 'pr')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('refusal, the association withdrawing, and the first announce', () => {
    it('a refusal is recorded, tells the proposer, and stands', async () => {
      const proposal = await personal.request(P(7), AG, 'pr');
      told.length = 0;
      await proposals.refuse(proposal.id, 'au', false);
      expect(told).toEqual([
        expect.objectContaining({ type: 'repost_personal_refused', recipientIds: ['pr'] }),
      ]);
      expect(await sees(P(7), 'gr')).toBe(false);
      await expect(personal.request(P(7), AG, 'pr')).rejects.toBeInstanceOf(ConflictException);
    });

    it('the association withdrawing its own republication frees its place to ask again', async () => {
      const first = await personal.request(P(8), AG, 'pr');
      await proposals.accept(first.id, 'au', false);
      // Somebody else may not withdraw it.
      await expect(republications.unrepublish(P(8), AG, 'plain', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await republications.unrepublish(P(8), AG, 'pr', false);
      expect(await proposalOf(P(8), AG)).toMatchObject({ status: 'withdrawn' });
      told.length = 0;
      const second = await personal.request(P(8), AG, 'pr');
      expect(second.status).toBe('pending');
      // Asked before: in the inbox, but neither a bell row nor a push a second time.
      expect(told).toEqual([]);
    });

    it('a pending request is withdrawn by its association, never by the author - and leaves the bell', async () => {
      const pending = await proposalOf(P(8), AG);
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "associationId") VALUES
           ('au', 'repost_personal_requested', $1, $2), ('au', 'repost_personal_requested', $1, $3)`,
        [P(8), AG, AG2]
      );
      await expect(proposals.withdraw(pending.id, 'au', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      // The id and the status, nothing else: the row names the author and the post.
      await expect(proposals.withdraw(pending.id, 'pr', false)).resolves.toEqual({
        id: pending.id,
        status: 'withdrawn',
      });
      // AG's request is gone from au's bell; another association's is not.
      expect(
        await q(`SELECT "associationId" FROM post_notifications WHERE "postId" = $1`, [P(8)])
      ).toEqual([{ associationId: AG2 }]);
    });

    it('an ask -> withdraw loop announces once, however many times it runs', async () => {
      told.length = 0;
      for (let i = 0; i < 3; i++) {
        const asked = await personal.request(P(8), AG, 'pr');
        await proposals.withdraw(asked.id, 'pr', false);
      }
      expect(told.filter((t) => t.type === 'repost_personal_requested')).toEqual([]);
    });

    it('a request whose asker no longer holds the flag, or is muted, is voided at acceptance', async () => {
      const lost = await personal.request(P(13), AG2, 'pr');
      await setFlag('pr', AG2, 0);
      try {
        const err = await refusedWith(proposals.accept(lost.id, 'au', false));
        expect(err).toBeInstanceOf(ConflictException);
        expect(codeOf(err)).toBe(PROPOSAL_SENDER_GONE);
      } finally {
        await setFlag('pr', AG2, POST_AS);
      }
      // Voided by the server: `decidedBy` names neither the author nor the asker.
      expect(await proposalOf(P(13), AG2)).toMatchObject({
        status: 'withdrawn',
        decidedBy: PROPOSAL_VOIDED_BY,
      });
      expect(await q(`SELECT 1 FROM post_republications WHERE "postId" = $1`, [P(13)])).toEqual([]);

      const mutedAsk = await personal.request(P(13), AG2, 'pr');
      await setMuted('pr', true);
      try {
        const err = await refusedWith(proposals.accept(mutedAsk.id, 'au', false));
        expect(codeOf(err)).toBe(PROPOSAL_SENDER_GONE);
      } finally {
        await setMuted('pr', false);
      }
      expect(await q(`SELECT 1 FROM post_republications WHERE "postId" = $1`, [P(13)])).toEqual([]);
    });

    it('an acceptance takes the post before the proposal, as a hide does, so the two cannot deadlock', async () => {
      const asked = await personal.request(P(14), AG, 'pr');
      // A moderation hide in flight: it holds the post row.
      const hide = ds.createQueryRunner();
      await hide.connect();
      await hide.startTransaction();
      await hide.query(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P(14)]);
      const accepting = proposals.accept(asked.id, 'au', false);
      // Settled whatever the outcome, so a failure below cannot leave it unhandled.
      const settled = accepting.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      let proposalFree: boolean;
      try {
        // Waits on the hide's row, whatever its order; this sleep only lets it get there. The
        // verdict is the lock state below, never the duration.
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The acceptance waits on the post and has NOT taken the proposal, so the hide could still
        // delete it. Taking the proposal first would make this NOWAIT fail (SQLSTATE 55P03).
        proposalFree = await q(`SELECT 1 FROM proposals WHERE id = $1 FOR UPDATE NOWAIT`, [
          asked.id,
        ]).then(
          () => true,
          () => false
        );
      } finally {
        await hide.rollbackTransaction();
        await hide.release();
      }
      expect(proposalFree).toBe(true);
      expect(await settled).toMatchObject({ value: { status: 'accepted' } });
    });

    it('a request whose asker stopped speaking is hidden from the author, and voided when the association asks again', async () => {
      const stale = await personal.request(P(17), AG2, 'pr');
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "associationId")
           VALUES ('au', 'repost_personal_requested', $1, $2)`,
        [P(17), AG2]
      );
      await setFlag('pr', AG2, 0);
      try {
        // Not shown, not counted: accepting it could only end in PROPOSAL_SENDER_GONE.
        const inbox = await personal.inbox('au');
        expect(inbox.incoming.map((r) => r.id)).not.toContain(stale.id);
        expect((await personal.pendingCount('au')).pending).toBe(inbox.incoming.length);
        // Another officer of AG2 asks: the stale request held the pair's place, and is voided.
        const fresh = await personal.request(P(17), AG2, 'pr2');
        expect(fresh).toMatchObject({ status: 'pending', proposedBy: 'pr2' });
      } finally {
        await setFlag('pr', AG2, POST_AS);
      }
      const old: Proposal[] = await q(`SELECT * FROM proposals WHERE id = $1`, [stale.id]);
      expect(old[0]).toMatchObject({ status: 'withdrawn', decidedBy: PROPOSAL_VOIDED_BY });
      expect(
        await q(`SELECT 1 FROM post_notifications WHERE "postId" = $1 AND "associationId" = $2`, [
          P(17),
          AG2,
        ])
      ).toEqual([]);
    });

    it('an acceptance waits on an association being deleted before it takes the post', async () => {
      const asked = await personal.request(P(19), AG3, 'pr');
      // The association delete in flight: it holds the association, and its cascade the request.
      const drop = ds.createQueryRunner();
      await drop.connect();
      await drop.startTransaction();
      let postFree: boolean;
      let settled: Promise<{ value?: unknown; error?: unknown }>;
      try {
        await drop.query(`DELETE FROM associations WHERE id = $1`, [AG3]);
        settled = proposals.accept(asked.id, 'au', false).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        await lockWaiters(1);
        // Holding the post while waiting on the cascade's request is the half of a deadlock the
        // delete would close by reaching the post: the acceptance must hold nothing yet.
        postFree = await q(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE NOWAIT`, [P(19)]).then(
          () => true,
          () => false
        );
      } finally {
        await drop.rollbackTransaction();
        await drop.release();
      }
      expect(postFree).toBe(true);
      expect(await settled).toMatchObject({ value: { status: 'accepted' } });
    }, 30_000);

    it('before the first announce, the followers are left to the sweep and the rest told here', async () => {
      const proposal = await personal.request(P(4), AG, 'pr');
      told.length = 0;
      await proposals.accept(proposal.id, 'au', false);
      // gf follows au: they see the post already (WP-F5), and the sweep tells them. gb blocked au:
      // nobody tells them. gr's request is still pending, so the sweep does not count gr: told here.
      expect(told[0]).toMatchObject({
        type: 'association_repost',
        recipientIds: ['gr', 'outsider'],
      });
    });

    it('a muted author cannot accept: it would widen what they published', async () => {
      const proposal = await personal.request(P(10), AG, 'pr');
      const err = await refusedWith(proposals.accept(proposal.id, 'mu', false));
      expect(codeOf(err)).toBe(PERSONAL_REPOST_CODES.authorMuted);
      // The refusal rolled the decision back: still pending.
      expect(await proposalOf(P(10), AG)).toMatchObject({ status: 'pending' });
    });
  });

  describe('moderation, deletion and erasure', () => {
    it('hiding the post removes its pending requests and its republications', async () => {
      await personal.request(P(9), AG, 'pr');
      const pending = await proposalOf(P(9), AG);
      await proposals.accept(pending.id, 'au', false);
      await personal.request(P(9), AG2, 'pr');
      const dropped = await dropRepublicationsOf(ds.manager, P(9));
      expect(dropped).toEqual({ republications: 1, proposals: 1 });
      expect(await sees(P(9), 'gr')).toBe(false);
    });

    it('deleting the post removes every request about it (migration 096 trigger)', async () => {
      await q(`DELETE FROM posts WHERE id = $1`, [P(9)]);
      expect(await q(`SELECT 1 FROM proposals WHERE "subjectId" = $1`, [P(9)])).toEqual([]);
    });

    it('an erasure and an acceptance racing on one post both complete, and the erased asker`s other request is voided', async () => {
      // er asks for two posts, and reacted to the first.
      const raced = await personal.request(P(16), AG, 'er');
      const other = await personal.request(P(17), AG, 'er');
      await q(`UPDATE posts SET reactions = '{"er": "like"}' WHERE id = $1`, [P(16)]);
      // The bell row as `announce` writes it: its actor is the asker.
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "associationId", "actorId")
           VALUES ('au', 'repost_personal_requested', $1, $2, 'er')`,
        [P(17), AG]
      );
      // The tables this schema has: the erasure's other statements name tables it does not.
      const present = new Set(
        (
          (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [
            schema,
          ])) as { table_name: string }[]
        ).map((r) => r.table_name)
      );
      // Skipped, and logged in `into`, when a table it names is missing or it writes a LOCK_ONLY
      // table. A name followed by `(` is a function (`FROM unnest(...)`), never a table.
      const skips = (sql: string, into: string[]): boolean => {
        const names = [...sql.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+([a-z_]+)\b(?!\s*\()/g)].map(
          (m) => m[1]
        );
        const skip = names.some((t) => !present.has(t)) || LOCK_ONLY.has(names[0]);
        if (skip) into.push(sql);
        return skip;
      };
      const skipped: string[] = [];
      const hold = ds.createQueryRunner();
      const erase = ds.createQueryRunner();
      await hold.connect();
      await erase.connect();
      let accepting: Promise<{ value?: unknown; error?: unknown }> | undefined;
      let erasing: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        // Lines both writers up behind one holder of the post, the acceptance first.
        await hold.startTransaction();
        await hold.query(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE`, [P(16)]);
        accepting = proposals.accept(raced.id, 'au', false).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        await lockWaiters(1);
        await erase.startTransaction();
        const db: ErasureDb = {
          write: async (sql, params) =>
            skips(sql, skipped) ? 0 : ((await erase.query(sql, params)) as [unknown, number])[1],
          read: async <T>(sql: string, params: unknown[]) =>
            skips(sql, skipped) ? [] : ((await erase.query(sql, params)) as T[]),
        };
        erasing = eraseSocialRows(db, 'er').then(
          async (value) => {
            await erase.commitTransaction();
            return { value };
          },
          async (error: unknown) => {
            await erase.rollbackTransaction();
            return { error };
          }
        );
        await lockWaiters(2);
      } finally {
        if (hold.isTransactionActive) await hold.rollbackTransaction();
        await hold.release();
      }
      // A proposal taken before the post would make this a 40P01 and abort one of them.
      expect(await accepting).toMatchObject({ value: { status: 'accepted' } });
      // The association lock ran (AG, through er's requests), and so did the mention scrub, whose
      // `FROM unnest(...)` is a function, not a table.
      expect(await erasing).toMatchObject({ value: { counts: { associations_locked: 1 } } });
      const mentions = ERASURE_STATEMENTS.find((s) => s.label === 'post_mentions')!.sql;
      expect(skipped).not.toContain(mentions);
      expect(skipped).not.toContain(ERASURE_ASSOCIATION_LOCK_SQL);
      await erase.release();
      expect(await proposalOf(P(16), AG)).toMatchObject({
        status: 'accepted',
        proposedBy: '[deleted]',
      });
      // The erased asker's other request no longer waits on the author, and left the bell.
      const voided: Proposal[] = await q(`SELECT * FROM proposals WHERE id = $1`, [other.id]);
      expect(voided[0]).toMatchObject({ status: 'withdrawn', decidedBy: PROPOSAL_VOIDED_BY });
      expect(
        await q(`SELECT 1 FROM post_notifications WHERE "postId" = $1 AND "associationId" = $2`, [
          P(17),
          AG,
        ])
      ).toEqual([]);
    }, 30_000);

    it('the erasure locks the associations its post deletion and form rows reach', async () => {
      // `lk`'s personal post, republished by AG2: deleting the post cascades into the republication.
      // `lk` answered a form of A1: deleting its respondent row touches A1's form.
      const POST = '00000000-0000-4000-8000-00000000f1c0';
      const FORM = '00000000-0000-4000-8000-00000000f1c1';
      await q(`INSERT INTO posts (id, "authorId") VALUES ($1, 'lk')`, [POST]);
      await q(
        `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'pr')`,
        [POST, AG2]
      );
      await q(`INSERT INTO forms (id, "associationId", "ownerId") VALUES ($1, $2, 'someone')`, [
        FORM,
        A1,
      ]);
      await q(`INSERT INTO form_respondents ("formId", "userId") VALUES ($1, 'lk')`, [FORM]);
      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        const locked: { id: string }[] = await runner.query(ERASURE_ASSOCIATION_LOCK_SQL, ['lk']);
        expect(locked.map((r) => r.id)).toEqual([AG2, A1].sort());
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
        await q(`DELETE FROM form_respondents WHERE "userId" = 'lk'`);
        await q(`DELETE FROM forms WHERE id = $1`, [FORM]);
        await q(`DELETE FROM posts WHERE id = $1`, [POST]);
      }
    });

    it("the author's erasure removes the requests addressed to them", async () => {
      const statement = ERASURE_STATEMENTS.find((s) => s.label === 'proposals_to_user');
      expect(statement).toBeDefined();
      await q(statement!.sql, ['mu']);
      expect(await q(`SELECT 1 FROM proposals WHERE "toUserId" = 'mu'`)).toEqual([]);
    });
  });

  describe('the schema itself', () => {
    it('a proposal targets exactly one receiver, and the kind decides which', async () => {
      await expect(
        q(
          `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "toUserId", "proposedBy")
           VALUES ('repost', $1, $2, NULL, 'au', 'pr')`,
          [P(12), AG]
        )
      ).rejects.toThrow(/CHK_proposals_(user_target_kind|one_target)/);
      await expect(
        q(
          `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "toUserId", "proposedBy")
           VALUES ('repost-personal', $1, $2, $3, NULL, 'pr')`,
          [P(12), AG, AG2]
        )
      ).rejects.toThrow(/CHK_proposals_(user_target_kind|one_target)/);
      await expect(
        q(
          `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", "toUserId", "proposedBy")
           VALUES ('repost-personal', $1, $2, $3, 'au', 'pr')`,
          [P(12), AG, AG2]
        )
      ).rejects.toThrow(/CHK_proposals_(user_target_kind|one_target)/);
    });
  });

  describe('the caps, on state', () => {
    afterEach(async () => {
      await q(`DELETE FROM proposals WHERE "proposedBy" = 'filler'`);
    });

    it(`an author holds at most ${MAX_PENDING_REQUESTS_PER_AUTHOR} pending requests`, async () => {
      await q(
        `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toUserId", "proposedBy")
         SELECT 'repost-personal', gen_random_uuid(), $1, 'au', 'filler'
           FROM generate_series(1, $2::int - (SELECT count(*)::int FROM proposals p
                WHERE p."toUserId" = 'au' AND p.status = 'pending'
                  AND ${personal.senderSpeaksSql('p')}))`,
        [AG2, MAX_PENDING_REQUESTS_PER_AUTHOR]
      );
      expect(codeOf(await refusedWith(personal.request(P(12), AG, 'pr')))).toBe(
        PERSONAL_REPOST_CODES.authorCap
      );
    });

    it(`an association holds at most ${MAX_PENDING_REQUESTS_PER_ASSOCIATION} pending requests`, async () => {
      await q(
        `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toUserId", "proposedBy")
         SELECT 'repost-personal', gen_random_uuid(), $1, 'someone-' || g, 'filler'
           FROM generate_series(1, $2::int - (SELECT count(*)::int FROM proposals p
                WHERE p."fromAssociationId" = $1 AND p.status = 'pending'
                  AND ${personal.senderSpeaksSql('p')})) g`,
        [AG2, MAX_PENDING_REQUESTS_PER_ASSOCIATION]
      );
      expect(codeOf(await refusedWith(personal.request(P(12), AG2, 'pr')))).toBe(
        PERSONAL_REPOST_CODES.associationCap
      );
      // Another association is not held by AG2's waiting requests.
      await expect(personal.request(P(12), AG, 'pr')).resolves.toMatchObject({
        status: 'pending',
      });
    });

    it('a request whose asker no longer speaks holds no seat', async () => {
      // A full author's worth of requests from askers with no membership left (left, or erased).
      await q(
        `INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toUserId", "proposedBy")
         SELECT 'repost-personal', gen_random_uuid(), $1, 'au', 'gone-' || g
           FROM generate_series(1, $2::int) g`,
        [AG2, MAX_PENDING_REQUESTS_PER_AUTHOR]
      );
      try {
        await expect(personal.request(P(18), AG2, 'pr')).resolves.toMatchObject({
          status: 'pending',
        });
      } finally {
        await q(`DELETE FROM proposals WHERE "proposedBy" LIKE 'gone-%'`);
      }
    });
  });
});
