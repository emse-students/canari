/**
 * REPUBLICATION AND PROPOSALS (D38), against a REAL PostgreSQL - migrations 071 to 073 included.
 *
 * `reader-spaces.integration.spec.ts` proves who SEES a republished post; this file drives the two
 * services that write one - `RepublicationsService` (the pull and the `repost` kind) and the generic
 * `ProposalsService` - through a real TypeORM connection, so the transactions, the row lock, the
 * unique index and the conditional updates are PostgreSQL's and not a fake's. The association
 * rights come from the members table (a stand-in for `mayAct` reading the same bit), and the
 * notifications are recorded rather than sent.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files: CI provides no database, and
 * the file reports as skipped rather than passing. Run it against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- republications.integration
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
  NotFoundException,
} from '@nestjs/common';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import type { AssociationsService } from '../associations/associations.service';
import type { RedisService } from '../common/redis/redis.service';
import { Proposal } from '../proposals/proposal.entity';
import { ProposalsService } from '../proposals/proposals.service';
import { PostRepublication } from './entities/post-republication.entity';
import type { PostNotificationsService } from './post-notifications.service';
import { RepublicationsService } from './republications.service';
import { dropRepublicationsOf } from './republication-sql';
import { postVisibleToViewerSql } from '../spaces/reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;

/** The cast. Readable ids: a failure names a person. */
const USERS: Record<string, { campus: string | null; formation: string | null }> = {
  // Publisher of A1 (ICM Saint-Etienne).
  aSe: { campus: 'saint-etienne', formation: 'ICM' },
  // Publisher of A2 (Gardanne), and a Gardanne student.
  bGa: { campus: 'gardanne', formation: 'ISMIN' },
  // A Gardanne reader, member of nothing.
  cGa: { campus: 'gardanne', formation: 'ISMIN' },
  // An ICM Saint-Etienne reader, member of nothing.
  dSe: { campus: 'saint-etienne', formation: 'ICM' },
  // An ICM Saint-Etienne student who may ALSO publish as A2.
  eSe: { campus: 'saint-etienne', formation: 'ICM' },
  // Publisher of the promo list L.
  lister: { campus: 'saint-etienne', formation: 'ICM' },
};

const A1 = '00000000-0000-4000-8000-00000000a001'; // (ICM, saint-etienne)
const A2 = '00000000-0000-4000-8000-00000000a002'; // (NULL, gardanne)
const L = '00000000-0000-4000-8000-00000000a00f'; // a promo list, (ICM, saint-etienne)

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POSTS: {
  id: string;
  authorId: string;
  associationId: string | null;
  announced: boolean;
  hidden?: boolean;
}[] = [
  { id: P(1), authorId: 'aSe', associationId: A1, announced: true },
  { id: P(2), authorId: 'aSe', associationId: null, announced: true },
  { id: P(3), authorId: 'aSe', associationId: A1, announced: false },
  { id: P(4), authorId: 'aSe', associationId: A1, announced: true, hidden: true },
  { id: P(5), authorId: 'aSe', associationId: A1, announced: true },
  { id: P(6), authorId: 'aSe', associationId: A1, announced: true },
  { id: P(7), authorId: 'aSe', associationId: A1, announced: true },
  { id: P(8), authorId: 'aSe', associationId: A1, announced: true },
];

maybe('republication and proposals against PostgreSQL (migrations 071-073)', () => {
  const schema = `repost_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let republications: RepublicationsService;
  let proposals: ProposalsService;
  const told: { type: string; postId: string; recipientIds: string[]; actorName?: string }[] = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The bit `mayAct` reads, from the real members table - and nothing about BDEs or admins. */
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
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "logoUrl" varchar, "logoMediaId" varchar,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, markdown text,
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
    `);
    await q(
      `INSERT INTO associations (id, name, slug, type) VALUES
         ($1, 'A1', 'a1', 'association'), ($2, 'A2', 'a2', 'association'), ($3, 'L', 'l', 'list')`,
      [A1, A2, L]
    );
    // As shipped: every association gets (ICM, saint-etienne); then the grid moves A2 to Gardanne.
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(`DELETE FROM association_audiences WHERE "associationId" = $1`, [A2]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
      [A2]
    );
    for (const [id, u] of Object.entries(USERS)) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : []),
      ]);
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId", permissions) VALUES
         ($1, 'aSe', $4), ($2, 'bGa', $4), ($2, 'eSe', $4), ($3, 'lister', $4)`,
      [A1, A2, L, POST_AS]
    );
    for (const p of POSTS) {
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", "hiddenByModeration", markdown, "feedNotifiedAt")
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          p.id,
          p.authorId,
          p.associationId,
          p.hidden ?? false,
          `post ${p.id.slice(-1)}`,
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
      // `createNotifications` drops the actor from its own recipients; the stand-in does the same.
      createNotifications: (data: {
        type: string;
        postId: string;
        actorId: string;
        actorName?: string;
        recipientIds: string[];
      }) => {
        const recipientIds = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
        told.push({ ...data, recipientIds: recipientIds.sort() });
        return Promise.resolve(recipientIds.length);
      },
    } as unknown as PostNotificationsService;
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
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  beforeEach(() => {
    told.length = 0;
  });

  describe('the pull: an association republishes what its publisher sees', () => {
    it('refuses a post the actor cannot see, even with the right to publish (404)', async () => {
      // bGa publishes for A2 but is in Gardanne; P1 reaches ICM Saint-Etienne only.
      await expect(republications.republish(P(1), A2, 'bGa', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('refuses a reader who may not publish as the association (403)', async () => {
      await expect(republications.republish(P(1), A2, 'dSe', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('republishes at once, and tells ONLY those who see the post for the first time', async () => {
      expect(await sees(P(1), 'cGa')).toBe(false);
      const result = await republications.republish(P(1), A2, 'eSe', false);
      // Gardanne: bGa (a member of A2, who could not see A1's post) and cGa. Not the ICM readers.
      expect(result.newlyReached).toBe(2);
      expect(told).toEqual([
        expect.objectContaining({
          type: 'association_repost',
          postId: P(1),
          actorName: 'A2',
          recipientIds: ['bGa', 'cGa'],
        }),
      ]);
      expect(await sees(P(1), 'cGa')).toBe(true);
      expect(await sees(P(1), 'dSe')).toBe(true);
    });

    it('is idempotent: the same pair a second time is a 409, and tells nobody', async () => {
      await expect(republications.republish(P(1), A2, 'eSe', false)).rejects.toBeInstanceOf(
        ConflictException
      );
      expect(told).toEqual([]);
    });

    it('never republishes a personal post (400), whoever asks', async () => {
      await expect(republications.republish(P(2), A2, 'eSe', false)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('refuses a hidden post (404) and a promo list as the republisher (400)', async () => {
      await expect(republications.republish(P(4), A2, 'eSe', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
      await expect(republications.republish(P(5), L, 'lister', false)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('tells nobody for a post not announced yet: the sweeper will count its new readers', async () => {
      const result = await republications.republish(P(3), A2, 'eSe', false);
      expect(result.newlyReached).toBe(0);
      expect(told).toEqual([]);
      expect(await sees(P(3), 'cGa')).toBe(true);
    });

    it('lets the association withdraw its own republication, and nobody else', async () => {
      await expect(republications.unrepublish(P(3), A2, 'dSe', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await republications.unrepublish(P(3), A2, 'bGa', false);
      expect(await sees(P(3), 'cGa')).toBe(false);
      await expect(republications.unrepublish(P(3), A2, 'bGa', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });
  });

  describe('the push: a proposal the other association decides', () => {
    it('only the post publishers propose (403), never to a list (400) nor to itself (400)', async () => {
      await expect(republications.propose(P(5), A2, 'dSe', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(republications.propose(P(5), L, 'aSe', false)).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(republications.propose(P(5), A1, 'aSe', false)).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(republications.propose(P(2), A2, 'aSe', false)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('stores a pending proposal and tells the receiving association publishers', async () => {
      const proposal = await republications.propose(P(5), A2, 'aSe', false);
      expect(proposal).toMatchObject({ status: 'pending', fromAssociationId: A1 });
      expect(told).toEqual([
        // The RECEIVING association rides in `postId`: the acceptor opens its queue.
        expect.objectContaining({
          type: 'repost_proposed',
          postId: A2,
          actorName: 'A1',
          recipientIds: ['bGa', 'eSe'],
        }),
      ]);
      // Nothing is visible yet: a proposal is a question, not a republication.
      expect(await sees(P(5), 'cGa')).toBe(false);
    });

    it('refuses the same proposal twice (409)', async () => {
      await expect(republications.propose(P(5), A2, 'aSe', false)).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('queues it for the receiver and the sender, and for nobody else', async () => {
      const forReceiver = await proposals.listPending(A2, 'bGa', false);
      expect(forReceiver.incoming.map((p) => p.subjectId)).toEqual([P(5)]);
      expect(forReceiver.incoming[0].subject).toMatchObject({ associationName: 'A1' });
      const forSender = await proposals.listPending(A1, 'aSe', false);
      expect(forSender.outgoing.map((p) => p.subjectId)).toEqual([P(5)]);
      await expect(proposals.listPending(A2, 'cGa', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('is accepted by a receiver publisher only, and then reaches its audience once', async () => {
      const [pending] = (await proposals.listPending(A2, 'bGa', false)).incoming;
      await expect(proposals.accept(pending.id, 'cGa', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      // The SENDER cannot accept in the receiver's name either.
      await expect(proposals.accept(pending.id, 'aSe', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      const accepted = await proposals.accept(pending.id, 'bGa', false);
      expect(accepted).toMatchObject({ status: 'accepted', decidedBy: 'bGa' });
      expect(await sees(P(5), 'cGa')).toBe(true);
      // The acceptor is the actor; cGa is the one Gardanne reader left to tell.
      expect(told).toEqual([
        expect.objectContaining({ type: 'association_repost', recipientIds: ['cGa'] }),
      ]);
      await expect(proposals.accept(pending.id, 'bGa', false)).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('records a refusal, which stands: the same proposal cannot be made again', async () => {
      const proposal = await republications.propose(P(6), A2, 'aSe', false);
      const refused = await proposals.refuse(proposal.id, 'bGa', false);
      expect(refused).toMatchObject({ status: 'refused', decidedBy: 'bGa' });
      expect(await sees(P(6), 'cGa')).toBe(false);
      await expect(republications.propose(P(6), A2, 'aSe', false)).rejects.toBeInstanceOf(
        ConflictException
      );
      expect((await proposals.listPending(A2, 'bGa', false)).incoming).toEqual([]);
    });

    it('is withdrawn by its sender only, which makes room for a new one', async () => {
      const proposal = await republications.propose(P(7), A2, 'aSe', false);
      await expect(proposals.withdraw(proposal.id, 'bGa', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(await proposals.withdraw(proposal.id, 'aSe', false)).toMatchObject({
        status: 'withdrawn',
      });
      const again = await republications.propose(P(7), A2, 'aSe', false);
      expect(again.status).toBe('pending');
      expect(again.id).not.toBe(proposal.id);
    });

    it('a pull by the receiver settles its pending proposal as accepted', async () => {
      const proposal = await republications.propose(P(8), A2, 'aSe', false);
      await republications.republish(P(8), A2, 'eSe', false);
      const rows: { status: string; decidedBy: string }[] = await q(
        `SELECT status, "decidedBy" FROM proposals WHERE id = $1`,
        [proposal.id]
      );
      expect(rows[0]).toEqual({ status: 'accepted', decidedBy: 'eSe' });
    });
  });

  describe('what hiding and deleting the original take with them', () => {
    it('hiding removes every republication and every pending proposal, and keeps decisions', async () => {
      // P7 has a pending proposal (withdrawn once, proposed again) and P5 an accepted one.
      const dropped = await dropRepublicationsOf(ds.manager, P(7));
      expect(dropped).toEqual({ republications: 0, proposals: 1 });
      const p5 = await dropRepublicationsOf(ds.manager, P(5));
      expect(p5).toEqual({ republications: 1, proposals: 0 });
      expect(await sees(P(5), 'cGa')).toBe(false);
      const kept: { n: number }[] = await q(
        `SELECT count(*)::int AS n FROM proposals WHERE "subjectId" = $1 AND status = 'accepted'`,
        [P(5)]
      );
      expect(kept[0].n).toBe(1);
    });

    it('deleting removes its republications (foreign key) and its proposals (trigger)', async () => {
      await q(`DELETE FROM posts WHERE id = $1`, [P(1)]);
      const left: { reps: number; props: number }[] = await q(
        `SELECT (SELECT count(*)::int FROM post_republications WHERE "postId" = $1) AS reps,
                (SELECT count(*)::int FROM proposals WHERE "subjectId" = $1) AS props`,
        [P(1)]
      );
      expect(left[0]).toEqual({ reps: 0, props: 0 });
      // P6's refused proposal goes with its post too: the subject is gone.
      await q(`DELETE FROM posts WHERE id = $1`, [P(6)]);
      const p6: { n: number }[] = await q(
        `SELECT count(*)::int AS n FROM proposals WHERE "subjectId" = $1`,
        [P(6)]
      );
      expect(p6[0].n).toBe(0);
    });
  });
});
