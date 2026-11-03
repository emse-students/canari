/**
 * THE ANNOUNCEMENT CLAIM, against a REAL PostgreSQL: `CLAIM_POST_ANNOUNCEMENT_SQL` is what makes a
 * post's mentions and announcement told once, and only for a post that is published at the claim.
 *
 * The scheduler runs as written; only its repository is a thin shim over `pg`. Its `find` returns
 * EVERY unstamped row on purpose - hidden, scheduled later or not - so the claim alone has to keep
 * them out, which is the property (re-review of #2947: the `find`'s snapshot was trusted, and a
 * post hidden or re-scheduled between the find and the claim was still told). The posts are
 * anonymous personal ones, which skips the audience query (`announcePersonalPost`), so no space
 * table is needed: who an announcement reaches is proven in `reader-spaces.integration.spec.ts`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- post-announce.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { PostAnnounceScheduler } from './post-announce.scheduler';
import type { Post } from './entities/post.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_LIVE = id(701);
const P_HIDDEN = id(702);
const P_LATER = id(703);
const P_HIDDEN_IN_RACE = id(704);

maybe('the announcement claim, against PostgreSQL', () => {
  const schema = `post_announce_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  let mentioned: string[];
  /** Runs after the sweep's `find` and before its first claim: the race window, made explicit. */
  let betweenFindAndClaim: () => Promise<void>;

  const rows = async (sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as Record<string, unknown>[];

  /** A raw `posts` row as the entity: `mentions` is a TypeORM simple-array, a comma-joined text. */
  const asPost = (r: Record<string, unknown>) =>
    ({
      ...r,
      mentions: String(r.mentions ?? '')
        .split(',')
        .filter(Boolean),
    }) as unknown as Post;

  const stamped = async (postId: string) =>
    (await rows(`SELECT "feedNotifiedAt" FROM posts WHERE id = $1`, [postId]))[0].feedNotifiedAt;

  function scheduler(): PostAnnounceScheduler {
    const manager = {
      query: (sql: string, params?: unknown[]) => rows(sql, params),
      findOne: async (_entity: unknown, opts: { where: { id: string } }) => {
        const [r] = await rows(`SELECT * FROM posts WHERE id = $1`, [opts.where.id]);
        return r ? asPost(r) : null;
      },
    };
    const postRepo = {
      // EVERY unstamped row, whatever it holds: the claim is what must refuse the wrong ones.
      find: async () => {
        const found = await rows(`SELECT * FROM posts WHERE "feedNotifiedAt" IS NULL ORDER BY id`);
        await betweenFindAndClaim();
        return found.map(asPost);
      },
      manager: {
        query: manager.query,
        transaction: async (fn: (m: typeof manager) => Promise<unknown>) => {
          await client.query('BEGIN');
          try {
            const out = await fn(manager);
            await client.query('COMMIT');
            return out;
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          }
        },
      },
    };
    const notifications = {
      notifyPostMentions: (post: Post) => {
        mentioned.push(post.id);
        return Promise.resolve(post.mentions.length);
      },
      createNotifications: () => Promise.resolve(0),
    };
    return new PostAnnounceScheduler(postRepo as never, notifications as never);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // The columns the claim and the scheduler read, typed as the entity declares them.
    await client.query(`
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        "feedNotifiedAt" timestamptz, "publishedAt" timestamptz NOT NULL DEFAULT now(),
        markdown text NOT NULL DEFAULT '', mentions text NOT NULL DEFAULT '');
    `);
    await client.query(
      `INSERT INTO posts (id, "authorId", anonymous, "hiddenByModeration", "scheduledAt", mentions)
         VALUES ($1, 'author', true, false, NULL, 'u1'),
                ($2, 'author', true, true, NULL, 'u1'),
                ($3, 'author', true, false, now() + interval '1 day', 'u1'),
                ($4, 'author', true, false, NULL, 'u1')`,
      [P_LIVE, P_HIDDEN, P_LATER, P_HIDDEN_IN_RACE]
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    mentioned = [];
    betweenFindAndClaim = () => Promise.resolve();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('claims and tells a published post once, a hidden or later one never, and one hidden after the find never', async () => {
    // The race, for real: the find has read P_HIDDEN_IN_RACE as published, then a moderator hides it.
    betweenFindAndClaim = async () => {
      await client.query(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [
        P_HIDDEN_IN_RACE,
      ]);
    };
    await scheduler().announcePosts();
    expect(mentioned).toEqual([P_LIVE]);
    expect(await stamped(P_LIVE)).toBeInstanceOf(Date);
    expect(await stamped(P_HIDDEN)).toBeNull();
    expect(await stamped(P_LATER)).toBeNull();
    expect(await stamped(P_HIDDEN_IN_RACE)).toBeNull();
  });

  it('a second sweep tells nobody again', async () => {
    await scheduler().announcePosts();
    expect(mentioned).toEqual([]);
  });

  it('a post unhidden later is claimed then, and told then, once', async () => {
    await client.query(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [
      P_HIDDEN_IN_RACE,
    ]);
    await scheduler().announcePosts();
    await scheduler().announcePosts();
    expect(mentioned).toEqual([P_HIDDEN_IN_RACE]);
  });
});
