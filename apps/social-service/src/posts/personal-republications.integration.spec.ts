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
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import type { ModerationService } from '../moderation/moderation.service';
import { Proposal } from '../proposals/proposal.entity';
import { ProposalsService } from '../proposals/proposals.service';
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
};

const A = (n: number) => `00000000-0000-4000-8000-0000000b${String(n).padStart(4, '0')}`;
const AG = A(1); // association, Gardanne
const AG2 = A(2); // association, Gardanne, for the association cap
const INST = A(3); // institution
const LIST = A(4); // promo list
const ARCH = A(5); // archived association
const A1 = A(6); // association of an association post

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
  const muted = new Set<string>(['mu']);
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
        "logoUrl" varchar, "logoMediaId" varchar, "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, markdown text,
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL);
    `);
    await q(
      `INSERT INTO associations (id, name, slug, type, archived) VALUES
         ($1, 'AG', 'ag', 'association', false), ($2, 'AG2', 'ag2', 'association', false),
         ($3, 'INST', 'inst', 'institution', false), ($4, 'LIST', 'list', 'list', false),
         ($5, 'ARCH', 'arch', 'association', true), ($6, 'A1', 'a1', 'association', false)`,
      [AG, AG2, INST, LIST, ARCH, A1]
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
    for (const asso of [AG, AG2, INST, LIST, ARCH]) {
      await q(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, 'pr', $2)`,
        [asso, POST_AS]
      );
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, 'outsider', $2), ($3, 'au', $2)`,
      [AG, POST_AS, A1]
    );
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('gb', 'au'), ('pr', 'bl')`);
    await q(`INSERT INTO user_follows ("followerUserId", "followedUserId") VALUES ('gf', 'au')`);
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
    const moderation = {
      isUserMuted: (id: string) => Promise.resolve(muted.has(id)),
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
      expect([...offer.personalRepublishAsIds].sort()).toEqual([AG, AG2].sort());
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
        // gr, gf, gb and outsider see AG and not the post (pr already does: shared space).
        details: { preview: 'post 01', newlyReached: 4 },
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
        // Announced already: every newly reached reader but the one who blocked the author.
        expect.objectContaining({
          type: 'association_repost',
          postId: P(1),
          recipientIds: ['gf', 'gr', 'outsider'],
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
      const second = await personal.request(P(8), AG, 'pr');
      expect(second.status).toBe('pending');
    });

    it('a pending request is withdrawn by its association, never by the author', async () => {
      const pending = await proposalOf(P(8), AG);
      await expect(proposals.withdraw(pending.id, 'au', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(proposals.withdraw(pending.id, 'pr', false)).resolves.toMatchObject({
        status: 'withdrawn',
      });
    });

    it('before the first announce, the followers are left to the sweep and the rest told here', async () => {
      const proposal = await personal.request(P(4), AG, 'pr');
      told.length = 0;
      await proposals.accept(proposal.id, 'au', false);
      // gf follows au: the sweep will tell them. gb blocked au: nobody tells them.
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
           FROM generate_series(1, $2::int - (SELECT count(*)::int FROM proposals
                WHERE "toUserId" = 'au' AND status = 'pending'))`,
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
           FROM generate_series(1, $2::int - (SELECT count(*)::int FROM proposals
                WHERE "fromAssociationId" = $1 AND status = 'pending')) g`,
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
  });
});
