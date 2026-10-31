/**
 * A PERSONAL POST AND A PERSONAL LIVE OPEN TO THE AUTHOR'S ACCEPTED FOLLOWERS, WHATEVER THEIR SPACE
 * (WP-F5, decisions 4 and 5 of the follow requests, user 2026-10-25, reconfirmed 2026-10-31) -
 * against a REAL PostgreSQL, migrations 071 to 078 and 114 included.
 *
 * The matrix the backlog asked for: accepted / pending / none x same space / other space x personal
 * / anonymous / association post, plus the live, the announcement, the live push, a block either
 * way, a removed follower, a read grant, the "Tout" feed (`followers: false`) and the newly-reached
 * rule of a republication. `reader-spaces.integration.spec.ts` keeps the space rules themselves.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- follower-visibility
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { ExecutionContext } from '@nestjs/common';
import { FollowRequestsService } from '../follows/follow-requests.service';
import { FeedAudienceGuard } from '../posts/feed-audience.guard';
import { liveAudienceSql } from '../lives/live-announcer';
import {
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  announceRecipientsSql,
  followOpensAcrossSpacesSql,
  liveVisibleToViewerSql,
  newlyReachedByPersonalRepublicationSql,
  postVisibleToUserSql,
  postVisibleToViewerSql,
} from './reader-spaces';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const ICM_SE = [{ formation: 'ICM', promo: 2024 }];
const ISMIN_GA = [{ formation: 'ISMIN', promo: 2024 }];

/** The cast. Readable ids on purpose: a failure names a role, never a uuid. */
const USERS: Record<string, { campus: string | null; cursus: unknown[] }> = {
  // An ICM Saint-Etienne student: the author of everything below.
  author: { campus: 'saint-etienne', cursus: ICM_SE },
  // Shares the author's space and follows nobody: the space rule, unchanged.
  sameSpace: { campus: 'saint-etienne', cursus: ICM_SE },
  // Gardanne: shares no space with the author. Accepted.
  farFollower: { campus: 'gardanne', cursus: ISMIN_GA },
  // Gardanne, ASKED and never answered.
  farPending: { campus: 'gardanne', cursus: ISMIN_GA },
  // Gardanne, no relation at all.
  farStranger: { campus: 'gardanne', cursus: ISMIN_GA },
  // A personnel: a campus, no cursus, so no space at all (D34-D36) - accepted by the student.
  personnel: { campus: 'saint-etienne', cursus: [] },
  // Gardanne, holds a read grant on the whole Saint-Etienne campus (WP7), follows nobody.
  grantee: { campus: 'gardanne', cursus: ISMIN_GA },
  // Gardanne, accepted - and then the AUTHOR blocked them; the severing missed the follow row.
  blockedByAuthor: { campus: 'gardanne', cursus: ISMIN_GA },
  // Gardanne, accepted - and then THEY blocked the author; the row is left behind as well.
  blockedTheAuthor: { campus: 'gardanne', cursus: ISMIN_GA },
  // Staff with a campus, no cursus, no membership: outside the feed gate, and follows nobody.
  staffAlone: { campus: 'saint-etienne', cursus: [] },
  // The same, but ASKED to follow the author: a request opens neither the posts nor the feed.
  staffAsked: { campus: 'saint-etienne', cursus: [] },
};
const EVERYONE = Object.keys(USERS);

/** The follows of the author, by status. Every accepted one survives in the table on purpose. */
const ACCEPTED = ['farFollower', 'personnel', 'blockedByAuthor', 'blockedTheAuthor'];
const PENDING = ['farPending', 'staffAsked'];
/** Of the accepted follows, the one migration 114 recorded: `acceptedAt = createdAt` (F1). */
const GRANDFATHERED = 'personnel';

const A1 = '00000000-0000-4000-8000-0000000005a1'; // (ICM, saint-etienne), as migration 071 seeds
const A2 = '00000000-0000-4000-8000-0000000005a2'; // the whole Gardanne campus
const P_PERSONAL = '00000000-0000-4000-8000-000000000501';
const P_ANONYMOUS = '00000000-0000-4000-8000-000000000502';
const P_ASSOCIATION = '00000000-0000-4000-8000-000000000503';
const L_PERSONAL = '00000000-0000-4000-8000-000000000511';
const L_ASSOCIATION = '00000000-0000-4000-8000-000000000512';

/** Who the author's personal items reach: the space, plus the accepted followers no block touches. */
const PERSONAL_READERS = ['author', 'farFollower', 'personnel', 'sameSpace'];

maybe('personal posts and lives open to accepted followers (WP-F5) against PostgreSQL', () => {
  const schema = `follow_vis_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  /** Who of the cast sees post `id` through `postVisibleToViewerSql` with `opts`. */
  const seersOfPost = async (id: string, opts: { followers?: boolean } = {}) => {
    const seen: string[] = [];
    for (const user of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${postVisibleToViewerSql('posts', '$2', opts)} AS v FROM posts WHERE posts.id = $1`,
        [id, user]
      );
      if (rows[0].v === true) seen.push(user);
    }
    return seen.sort();
  };

  /** Who of the cast sees live `id` (the watch paths' predicate). */
  const seersOfLive = async (id: string) => {
    const seen: string[] = [];
    for (const user of EVERYONE) {
      const { rows } = await client.query(
        `SELECT ${liveVisibleToViewerSql('lives', '$2')} AS v FROM lives WHERE lives.id = $1`,
        [id, user]
      );
      if (rows[0].v === true) seen.push(user);
    }
    return seen.sort();
  };

  const ids = (rows: { id: unknown }[]) => rows.map((r) => String(r.id)).sort();

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, formation varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255));
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
      CREATE TABLE lives (id uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
        "associationId" uuid);
      CREATE TABLE live_removed_viewers ("liveId" uuid NOT NULL, "viewerId" varchar(255) NOT NULL);
    `);
    await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'A1'), ($2, 'A2')`, [
      A1,
      A2,
    ]);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '074_coorganise.sql',
      '078_read_grants.sql',
      '114_user_follow_status.sql',
    ]) {
      await client.query(migration(name));
    }
    // 071 gave both (ICM, saint-etienne); A2 addresses the whole Gardanne campus instead.
    await client.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [A2]);
    await client.query(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
      [A2]
    );
    for (const [id, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.cursus),
      ]);
    }
    // Asked an hour ago, accepted now - except the grandfathered one, accepted "when it was made".
    for (const follower of ACCEPTED) {
      await client.query(
        `INSERT INTO user_follows ("followerUserId", "followedUserId", "createdAt", status, "acceptedAt")
           VALUES ($1, 'author', now() - interval '1 hour', 'accepted',
                   CASE WHEN $1::varchar = $2::varchar THEN (now() - interval '1 hour')::timestamp ELSE now() END)`,
        [follower, GRANDFATHERED]
      );
    }
    for (const follower of PENDING) {
      await client.query(
        `INSERT INTO user_follows ("followerUserId", "followedUserId") VALUES ($1, 'author')`,
        [follower]
      );
    }
    await client.query(
      `INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('author', 'blockedByAuthor'),
         ('blockedTheAuthor', 'author')`
    );
    await client.query(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('grantee', 'saint-etienne', NULL, 'it')`
    );
    await client.query(
      `INSERT INTO posts (id, "authorId", "associationId", anonymous) VALUES
         ($1, 'author', NULL, false), ($2, 'author', NULL, true), ($3, 'author', $4, false)`,
      [P_PERSONAL, P_ANONYMOUS, P_ASSOCIATION, A1]
    );
    await client.query(
      `INSERT INTO lives (id, "broadcasterId", "associationId") VALUES ($1, 'author', NULL), ($2, 'author', $3)`,
      [L_PERSONAL, L_ASSOCIATION, A1]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('the cast is what it claims: the far readers and the personnel share no space with the author', async () => {
    // Without the follower disjunct the personal post is the space rule alone.
    expect(await seersOfPost(P_PERSONAL, { followers: false })).toEqual(['author', 'sameSpace']);
  });

  it('a personal post reaches its ACCEPTED followers across spaces - a personnel included - and nobody else', async () => {
    // farPending only asked; farStranger and the grantee follow nobody; a block either way wins.
    expect(await seersOfPost(P_PERSONAL)).toEqual(PERSONAL_READERS);
  });

  it('an ANONYMOUS personal post never opens to a follower: following must not unmask its author', async () => {
    expect(await seersOfPost(P_ANONYMOUS)).toEqual(['author', 'sameSpace']);
    // And nobody is announced it as a follower (the scheduler does not even ask; the SQL agrees).
    const { rows } = await client.query(announceRecipientsSql(true), [P_ANONYMOUS]);
    expect(ids(rows)).toEqual([]);
  });

  it("an ASSOCIATION's post is untouched: following its author opens nothing of it", async () => {
    // A1 reaches ICM x saint-etienne; the grantee reads it by its grant (WP7), the followers do not.
    expect(await seersOfPost(P_ASSOCIATION)).toEqual(['author', 'grantee', 'sameSpace']);
  });

  it('a read grant never reaches the personal branch, the post or the live (WP7)', async () => {
    expect(await seersOfPost(P_PERSONAL)).not.toContain('grantee');
    expect(await seersOfLive(L_PERSONAL)).not.toContain('grantee');
  });

  it('"Tout" (`followers: false`) is the space rule for EVERYONE: unchanged for a non-follower, no follower reach', async () => {
    const posts = [P_PERSONAL, P_ANONYMOUS, P_ASSOCIATION];
    for (const user of EVERYONE.filter((u) => !ACCEPTED.includes(u))) {
      for (const post of posts) {
        const ask = async (opts: { followers?: boolean }) =>
          (
            await client.query(
              `SELECT ${postVisibleToViewerSql('posts', '$2', opts)} AS v FROM posts WHERE posts.id = $1`,
              [post, user]
            )
          ).rows[0].v;
        expect({ user, post, tout: await ask({ followers: false }) }).toEqual({
          user,
          post,
          tout: await ask({}),
        });
      }
    }
    // And the follower reads it in Suivis, not in Tout.
    expect(await seersOfPost(P_PERSONAL, { followers: false })).not.toContain('farFollower');
  });

  it('a personal post is ANNOUNCED to the accepted followers who see it, wherever they are', async () => {
    const { rows } = await client.query(announceRecipientsSql(true), [P_PERSONAL]);
    expect(ids(rows)).toEqual(['farFollower', 'personnel']);
  });

  it('a personal LIVE reaches the same readers, and its push the same followers', async () => {
    expect(await seersOfLive(L_PERSONAL)).toEqual(PERSONAL_READERS);
    const { rows } = await client.query(liveAudienceSql(false), ['author', L_PERSONAL]);
    expect(ids(rows)).toEqual(['farFollower', 'personnel']);
    // An association's live is the association's audience, followers of the broadcaster or not.
    expect(await seersOfLive(L_ASSOCIATION)).toEqual(['author', 'grantee', 'sameSpace']);
  });

  it('a block wins either way, even with the follow row left behind by the severing', async () => {
    for (const blocked of ['blockedByAuthor', 'blockedTheAuthor']) {
      expect(await seersOfPost(P_PERSONAL)).not.toContain(blocked);
      expect(await seersOfLive(L_PERSONAL)).not.toContain(blocked);
    }
    // Lifted: the accepted follow they still hold counts again - the block was the only thing
    // standing between them, which is what the left-over row means (backlog, WP-F4 review).
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM user_blocks`);
      expect(await seersOfPost(P_PERSONAL)).toEqual(
        [...PERSONAL_READERS, 'blockedByAuthor', 'blockedTheAuthor'].sort()
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a REMOVED follower loses the post, the live, the announcement and the push at once', async () => {
    await client.query('BEGIN');
    try {
      // The service's own statement, through this file's client: `[rows, rowCount]` as the driver.
      const viaClient = {
        query: async (sql: string, params: unknown[]) => {
          const r = await client.query(sql, params);
          return r.command === 'SELECT' ? r.rows : [r.rows, r.rowCount];
        },
      };
      const requests = new FollowRequestsService(
        {} as never,
        {} as never,
        viaClient as never,
        {
          deleteByPattern: () => Promise.resolve(0),
        } as never
      );
      expect(await requests.removeFollower('author', 'farFollower')).toEqual({ ok: true });
      expect(await seersOfPost(P_PERSONAL)).not.toContain('farFollower');
      expect(await seersOfLive(L_PERSONAL)).not.toContain('farFollower');
      expect(ids((await client.query(announceRecipientsSql(true), [P_PERSONAL])).rows)).toEqual([
        'personnel',
      ]);
      expect(
        ids((await client.query(liveAudienceSql(false), ['author', L_PERSONAL])).rows)
      ).toEqual(['personnel']);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('an UNFOLLOW is the same: the row goes, the opening goes', async () => {
    await client.query('BEGIN');
    try {
      // `FollowsService.unfollowUser`'s statement.
      await client.query(
        `DELETE FROM user_follows WHERE "followerUserId" = $1 AND "followedUserId" = $2`,
        ['personnel', 'author']
      );
      expect(await seersOfPost(P_PERSONAL)).not.toContain('personnel');
      expect(await seersOfLive(L_PERSONAL)).not.toContain('personnel');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('stays MONOTONE in republications: the newly reached are who see it after and not before', async () => {
    // A2 reaches all of Gardanne. farFollower sees the post already, so it is never "newly" reached;
    // the personal variant also leaves out both sides of a block (D38b).
    const plain = await client.query(NEWLY_REACHED_BY_REPUBLICATION_SQL, [P_PERSONAL, A2]);
    expect(ids(plain.rows)).toEqual([
      'blockedByAuthor',
      'blockedTheAuthor',
      'farPending',
      'farStranger',
      'grantee',
    ]);
    const personal = await client.query(newlyReachedByPersonalRepublicationSql(true), [
      P_PERSONAL,
      A2,
    ]);
    expect(ids(personal.rows)).toEqual(['farPending', 'farStranger', 'grantee']);

    // Against the state itself: write the row, compare after with before, roll back.
    const visibleTo = async () =>
      ids(
        (
          await client.query(
            `SELECT u.id FROM users u, posts WHERE posts.id = $1 AND ${postVisibleToUserSql('posts', 'u')}`,
            [P_PERSONAL]
          )
        ).rows
      );
    const before = await visibleTo();
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'it')`,
        [P_PERSONAL, A2]
      );
      const after = await visibleTo();
      expect(before.every((id) => after.includes(id))).toBe(true);
      expect(after.filter((id) => !before.includes(id))).toEqual(ids(plain.rows));
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('the FEED GATE admits a follower with no space and no membership, so the push and the read agree (F3)', async () => {
    const guard = new FeedAudienceGuard({
      manager: {
        query: async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows,
      },
    } as never);
    const asking = (userId: string) =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-user-id': userId } }) }),
      } as unknown as ExecutionContext);
    // personnel has no space and no membership: told of the author's post (announce above), and let in.
    await expect(asking('personnel')).resolves.toBe(true);
    // Neither a staff member following nobody, nor one whose request is unanswered.
    await expect(asking('staffAlone')).rejects.toMatchObject({ status: 403 });
    await expect(asking('staffAsked')).rejects.toMatchObject({ status: 403 });
    // And a removal closes the gate again with the reach: the row is the whole fact.
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM user_follows WHERE "followerUserId" = 'personnel'`);
      await expect(asking('personnel')).rejects.toMatchObject({ status: 403 });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('F1, HELD: the switch that would open only follows accepted by an ANSWER, not by migration 114', async () => {
    const openers = async (grandfathered: boolean) =>
      ids(
        (
          await client.query(
            `SELECT f."followerUserId" AS id FROM user_follows f
              WHERE f."followedUserId" = 'author' AND ${followOpensAcrossSpacesSql('f', grandfathered)}`
          )
        ).rows
      );
    // Today (`GRANDFATHERED_FOLLOWS_OPEN_ACROSS_SPACES` true): every accepted follow.
    expect(await openers(true)).toEqual([...ACCEPTED].sort());
    // Flipped: the grandfathered follow (acceptedAt = createdAt) no longer opens; a pending one never did.
    expect(await openers(false)).toEqual(ACCEPTED.filter((u) => u !== GRANDFATHERED).sort());
  });
});
